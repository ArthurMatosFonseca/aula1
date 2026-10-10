const SESSION_COOKIE = "sesi_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const TOKEN_SECONDS = 60 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}
function cookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const part = raw.split(";").map(x => x.trim()).find(x => x.startsWith(name + "="));
  return part ? part.slice(name.length + 1) : "";
}
function b64(bytes) { let s=""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function randomToken() { const b = new Uint8Array(32); crypto.getRandomValues(b); return b64(b); }
async function sha256(text) { return b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))); }
async function passwordHash(password, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64.replace(/-/g,"+").replace(/_/g,"/")), c=>c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", salt, iterations:310000, hash:"SHA-256" }, key, 256);
  return { salt: b64(salt), hash: b64(bits) };
}
function safeUser(row) { return row ? { id: row.id, name: row.name, email: row.email } : null; }
async function body(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > 25000) throw new Error("A solicitação é muito grande.");
  return await request.json();
}
function validEmail(email) { return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validPassword(p) { return typeof p === "string" && p.length >= 10 && p.length <= 200; }
function originOk(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("O envio de e-mails ainda não foi configurado no servidor.");
  const res = await fetch("https://api.resend.com/emails", { method:"POST", headers:{ Authorization:`Bearer ${env.RESEND_API_KEY}`, "Content-Type":"application/json" }, body:JSON.stringify({ from:env.EMAIL_FROM, to:[to], subject, html }) });
  if (!res.ok) throw new Error("Não foi possível enviar o e-mail. Confira a configuração de e-mail do servidor.");
}
async function issueActionToken(env, user, kind, urlBase, emailSubject, intro) {
  const token = randomToken(), tokenHash = await sha256(token), now = Math.floor(Date.now()/1000);
  await env.DB.prepare("DELETE FROM action_tokens WHERE user_id = ? AND kind = ?").bind(user.id,kind).run();
  await env.DB.prepare("INSERT INTO action_tokens (id,user_id,token_hash,kind,expires_at,created_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),user.id,tokenHash,kind,now+TOKEN_SECONDS,now).run();
  const link = `${urlBase}${urlBase.includes("?")?"&":"?"}${kind === "verify" ? "verify" : "reset"}=${encodeURIComponent(token)}`;
  await sendEmail(env,user.email,emailSubject,`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172b3a"><h2>${intro}</h2><p>Use o botão abaixo para continuar. O link expira em uma hora.</p><p><a href="${link}" style="display:inline-block;background:#1e5b8f;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">${kind === "verify" ? "Confirmar e-mail" : "Criar nova senha"}</a></p><p>Se você não solicitou isso, ignore esta mensagem.</p></div>`);
}
async function getUserFromSession(request, env) {
  const token = readCookie(request,SESSION_COOKIE); if (!token) return null;
  const tokenHash = await sha256(token), now = Math.floor(Date.now()/1000);
  const row = await env.DB.prepare("SELECT u.id,u.name,u.email,u.email_verified FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? LIMIT 1").bind(tokenHash,now).first();
  return row ? row : null;
}
async function createSession(userId, env) {
  const token=randomToken(), now=Math.floor(Date.now()/1000);
  await env.DB.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),userId,await sha256(token),now+SESSION_SECONDS,now).run();
  return token;
}
async function authRoute(path, request, env) {
  if (request.method === "GET" && path === "/api/auth/me") {
    const u=await getUserFromSession(request,env); return json({user:u&&u.email_verified?safeUser(u):null});
  }
  if (request.method !== "POST") return json({error:"Método não permitido."},405);
  if (!originOk(request)) return json({error:"Origem da solicitação não permitida."},403);
  let data; try { data=await body(request); } catch(e) { return json({error:e.message||"JSON inválido."},400); }
  const now=Math.floor(Date.now()/1000), appOrigin=(env.APP_ORIGIN||new URL(request.url).origin).replace(/\/$/,"");
  if (path === "/api/auth/register") {
    const name=String(data.name||"").trim(), email=String(data.email||"").trim().toLowerCase(), password=data.password;
    if (name.length<2 || name.length>120) return json({error:"Informe seu nome (de 2 a 120 caracteres)."},400);
    if (!validEmail(email)) return json({error:"Informe um e-mail válido."},400);
    if (!validPassword(password)) return json({error:"A senha precisa ter de 10 a 200 caracteres."},400);
    const existing=await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (existing) return json({error:"Já existe uma conta com esse e-mail. Tente entrar ou recuperar a senha."},409);
    const pass=await passwordHash(password), id=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO users (id,name,email,password_salt,password_hash,email_verified,created_at) VALUES (?,?,?,?,?,0,?)").bind(id,name,email,pass.salt,pass.hash,now).run();
    try { await issueActionToken(env,{id,email},"verify",appOrigin,"Confirme seu e-mail — Gerador SESI","Confirme seu e-mail"); }
    catch(e) { return json({error:e.message||"Conta criada, mas o e-mail não foi enviado. Use reenviar confirmação após configurar o e-mail."},502); }
    return json({ok:true,message:"Conta criada. Confira seu e-mail para confirmar o cadastro."},201);
  }
  if (path === "/api/auth/login") {
    const email=String(data.email||"").trim().toLowerCase(), password=String(data.password||"");
    const u=await env.DB.prepare("SELECT id,name,email,password_salt,password_hash,email_verified FROM users WHERE email=?").bind(email).first();
    if (!u) return json({error:"E-mail ou senha incorretos."},401);
    const candidate=await passwordHash(password,u.password_salt);
    if (candidate.hash !== u.password_hash) return json({error:"E-mail ou senha incorretos."},401);
    if (!u.email_verified) return json({error:"Confirme seu e-mail antes de entrar. Verifique a caixa de entrada ou peça um novo link."},403);
    const token=await createSession(u.id,env);
    return json({ok:true,user:safeUser(u)},200,{"Set-Cookie":cookie(token,SESSION_SECONDS)});
  }
  if (path === "/api/auth/verify") {
    const token=String(data.token||""); if(token.length<20) return json({error:"Link de confirmação inválido."},400);
    const row=await env.DB.prepare("SELECT id,user_id,kind,expires_at FROM action_tokens WHERE token_hash=? AND kind='verify'").bind(await sha256(token)).first();
    if(!row||row.expires_at<now) return json({error:"O link expirou ou já foi usado. Peça outro e-mail de confirmação."},400);
    await env.DB.batch([env.DB.prepare("UPDATE users SET email_verified=1 WHERE id=?").bind(row.user_id),env.DB.prepare("DELETE FROM action_tokens WHERE id=?").bind(row.id)]);
    return json({ok:true});
  }
  if (path === "/api/auth/resend-verification") {
    const email=String(data.email||"").trim().toLowerCase();
    const u=await env.DB.prepare("SELECT id,name,email,email_verified FROM users WHERE email=?").bind(email).first();
    if(u&&!u.email_verified){try{await issueActionToken(env,u,"verify",appOrigin,"Confirme seu e-mail — Gerador SESI","Confirme seu e-mail");}catch(e){return json({error:e.message},502);}}
    return json({ok:true,message:"Se houver uma conta pendente para esse e-mail, enviaremos um link."});
  }
  if (path === "/api/auth/forgot") {
    const email=String(data.email||"").trim().toLowerCase(); const u=await env.DB.prepare("SELECT id,name,email FROM users WHERE email=? AND email_verified=1").bind(email).first();
    if(u){try{await issueActionToken(env,u,"reset",appOrigin,"Recupere sua senha — Gerador SESI","Recuperação de senha");}catch(e){return json({error:e.message},502);}}
    return json({ok:true,message:"Se o e-mail estiver cadastrado, você receberá um link de recuperação."});
  }
  if (path === "/api/auth/reset") {
    const token=String(data.token||""), password=data.password;
    if(!validPassword(password)) return json({error:"A nova senha precisa ter de 10 a 200 caracteres."},400);
    const row=await env.DB.prepare("SELECT id,user_id,expires_at FROM action_tokens WHERE token_hash=? AND kind='reset'").bind(await sha256(token)).first();
    if(!row||row.expires_at<now) return json({error:"O link de recuperação expirou ou já foi usado. Solicite outro."},400);
    const pass=await passwordHash(password);
    await env.DB.batch([env.DB.prepare("UPDATE users SET password_salt=?,password_hash=? WHERE id=?").bind(pass.salt,pass.hash,row.user_id),env.DB.prepare("DELETE FROM action_tokens WHERE id=?").bind(row.id),env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(row.user_id)]);
    return json({ok:true});
  }
  if (path === "/api/auth/logout") {
    const token=readCookie(request,SESSION_COOKIE); if(token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ok:true},200,{"Set-Cookie":cookie("",0)});
  }
  return json({error:"Rota de autenticação não encontrada."},404);
}
async function generateReport(request, env) {
  if(request.method!=="POST") return json({error:"Método não permitido."},405);
  if(!originOk(request)) return json({error:"Origem da solicitação não permitida."},403);
  const user=await getUserFromSession(request,env);
  if(!user||!user.email_verified) return json({error:"Entre na sua conta para gerar relatórios."},401);
  if(!env.OPENAI_API_KEY) return json({error:"A IA ainda não foi configurada no servidor."},503);
  let p;try{p=await body(request);}catch(e){return json({error:e.message||"JSON inválido."},400);}
  const subject=["Química","Biologia"].includes(p.subject)?p.subject:"Química";
  const title=String(p.title||"").slice(0,180), objective=String(p.objective||"").slice(0,5000);
  if(!title||!objective) return json({error:"Preencha o tema e o objetivo do relatório."},400);
  const day=new Date().toISOString().slice(0,10);
  const usage=await env.DB.prepare("INSERT INTO usage_daily (user_id,day,count) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1 RETURNING count").bind(user.id,day).first();
  if(usage && usage.count>20){await env.DB.prepare("UPDATE usage_daily SET count=count-1 WHERE user_id=? AND day=?").bind(user.id,day).run();return json({error:"Você atingiu o limite de 20 relatórios por dia. Tente novamente amanhã."},429);}
  const fields={subject,student:p.student,studentClass:p.studentClass,teacher:p.teacher,type:p.type,title,audience:p.audience,tone:p.tone,objective,model:p.model,extra:p.extra,context:p.context,method:p.method,data:p.data,analysis:p.analysis,limits:p.limits,sources:p.sources};
  const prompt=`Elabore um relatório escolar de ${subject} em português brasileiro, adequado ao ensino médio e seguindo a estrutura de relatório da Escola SESI. Use exatamente estas seções: 1 Introdução; 2 Objetivos (objetivo geral e específicos); 3 Material e métodos; 4 Resultados e discussão; 5 Conclusão; 6 Referências.

PESQUISA NA INTERNET: use a ferramenta de pesquisa na web disponibilizada nesta solicitação para pesquisar o tema antes de redigir. Priorize fontes confiáveis e pertinentes, como órgãos públicos, universidades, artigos científicos e instituições reconhecidas. Baseie as afirmações factuais em fontes realmente consultadas. Não invente autores, títulos, URLs, dados ou referências. Diferencie fatos publicados de dados experimentais que o aluno deveria coletar. A pesquisa bibliográfica não comprova que um experimento foi realizado. Se não conseguir verificar uma informação, sinalize a limitação.

Não invente dados experimentais, observações ou procedimentos realizados. Na seção Material e métodos, descreva apenas o método informado pelo usuário ou, se não houver, deixe claro que a metodologia precisa ser definida. Em Resultados e discussão, não fabrique resultados: apresente a discussão bibliográfica que puder ser sustentada pelas fontes e sinalize quando faltarem dados experimentais. Use as fontes encontradas e as fontes fornecidas pelo usuário sem atribuir a elas informações que não contenham. Inclua citações no texto quando apropriado. A lista final de referências deve usar apenas fontes verificáveis consultadas. Não inclua capa, pois ela é montada no DOCX pelo navegador. Identificação e informações fornecidas: ${JSON.stringify(fields)}. Retorne somente o texto do relatório, com títulos de seção em linhas separadas.`;
  const res=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:env.OPENAI_MODEL||"gpt-4.1-mini",tools:[{type:"web_search"}],input:[{role:"system",content:[{type:"input_text",text:"Você é um assistente de redação científica escolar cuidadoso. Pesquise na web quando solicitado, use fontes reais e nunca fabrique evidências ou referências."}]},{role:"user",content:[{type:"input_text",text:prompt}]}],temperature:0.4,max_output_tokens:6000})});
  const out=await res.json().catch(()=>({}));
  if(!res.ok){await env.DB.prepare("UPDATE usage_daily SET count=MAX(0,count-1) WHERE user_id=? AND day=?").bind(user.id,day).run();return json({error:out.error?.message||"A IA não conseguiu pesquisar e gerar o relatório agora."},502);}
  let report=typeof out.output_text==="string"?out.output_text.trim():"";
  if(!report && Array.isArray(out.output)){
    report=out.output.flatMap(item=>Array.isArray(item.content)?item.content:[]).filter(item=>item.type==="output_text"&&typeof item.text==="string").map(item=>item.text).join("\n").trim();
  }
  if(!report){await env.DB.prepare("UPDATE usage_daily SET count=MAX(0,count-1) WHERE user_id=? AND day=?").bind(user.id,day).run();return json({error:"A IA não retornou um relatório válido."},502);}
  const foundSources=[];
  for(const item of (out.output||[])) for(const part of (item.content||[])) for(const ann of (part.annotations||[])) {
    if(ann.type==="url_citation" && ann.url && /^https?:\/\//i.test(ann.url) && !foundSources.some(x=>x.url===ann.url)) foundSources.push({title:String(ann.title||ann.url).slice(0,300),url:ann.url});
  }
  if(foundSources.length && !/fontes consultadas|referências/i.test(report.slice(-1200))){
    report += "\n\nFontes consultadas na pesquisa\n" + foundSources.map((source,i)=>`${i+1}. ${source.title} — ${source.url}`).join("\n");
  }
  return json({report,sources:foundSources,webSearchUsed:true});
}
export default {
  async fetch(request, env) {
    const url=new URL(request.url), path=url.pathname;
    try {
      if(path.startsWith("/api/auth/")) return await authRoute(path,request,env);
      if(path==="/api/generate") return await generateReport(request,env);
      if(path.startsWith("/api/")) return json({error:"Rota não encontrada."},404);
      return env.ASSETS.fetch(request);
    } catch(e) {
      console.error("Worker error",e);
      return json({error:"Erro interno do servidor. Tente novamente mais tarde."},500);
    }
  }
};
