# Gerador de Relatórios SESI — login + Química/Biologia + DOCX

Projeto sem Supabase. O frontend está em `public/index.html`; o backend de autenticação e geração de texto está em `src/index.js`. A base de dados é Cloudflare D1.

## O que está incluído

- Cadastro com nome, e-mail e senha.
- Senhas derivadas com PBKDF2-SHA-256; o sistema não armazena a senha em texto puro.
- Confirmação de e-mail por link de uso único, com expiração de uma hora.
- Login com cookie de sessão `HttpOnly`, `Secure` e `SameSite=Lax`.
- Recuperação de senha por link de uso único; a redefinição encerra as sessões antigas.
- Logout.
- Área de relatórios bloqueada até login e confirmação do e-mail.
- Geração de relatórios com IA no servidor, protegida por sessão, com limite básico de 20 relatórios por conta/dia.
- Pesquisa na web pela ferramenta `web_search` da OpenAI Responses API; quando a API devolver citações de URL, elas são anexadas ao relatório como fontes consultadas.
- Download do relatório em DOCX pelo navegador, com a estrutura e a formatação SESI implementadas no HTML.

## Importante

**Os arquivos estão preparados, mas o site ainda não está publicado nem conectado às suas contas.** Para login e IA funcionarem na internet, é necessário configurar Cloudflare D1, uma chave de API de IA e um serviço de envio de e-mail. Não coloque chaves secretas no HTML.

O sistema de e-mail deste projeto usa a API da Resend. Para entregar mensagens a qualquer usuário, configure um domínio verificado na Resend e use um remetente autorizado. O envio de confirmação e recuperação não funcionará até essa etapa estar pronta.

## Publicar no Cloudflare pelo computador

1. Crie/entre em uma conta em https://dash.cloudflare.com/.
2. Instale Node.js LTS no computador e, no terminal, entre na pasta deste projeto.
3. Crie o banco D1:
   ```bash
   npx wrangler login
   npx wrangler d1 create gerador-sesi-db
   ```
4. Copie o `database_id` retornado para `wrangler.toml`, substituindo `PREENCHA_COM_O_ID_DO_D1`.
5. Aplique o esquema do banco:
   ```bash
   npx wrangler d1 migrations apply gerador-sesi-db --remote
   ```
6. Cadastre os segredos, um por vez:
   ```bash
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put EMAIL_FROM
   ```
   - `OPENAI_API_KEY`: sua chave privada da API de IA.
   - `RESEND_API_KEY`: chave da Resend.
   - `EMAIL_FROM`: remetente autorizado, por exemplo `Gerador SESI <nao-responda@seudominio.com>`.
7. Publique:
   ```bash
   npx wrangler deploy
   ```
8. Abra o endereço `workers.dev` informado pelo Cloudflare. O mesmo endereço serve a página e a API, evitando configurar CORS manualmente.
9. Faça testes reais: cadastro, e-mail de confirmação, login, geração DOCX, sair, recuperação de senha e login com a nova senha.

Se o site usar um domínio próprio, configure `APP_ORIGIN` como variável/segredo com a URL pública completa, por exemplo `https://relatorios.seudominio.com`, e publique novamente. Use exatamente a origem pública do site.

## Pelo celular

É possível acompanhar a conta Cloudflare pelo navegador do celular, mas configurar D1, segredos e publicar código é bem mais simples em um computador. Não basta abrir o HTML localmente: o backend precisa estar publicado.

## Segurança e limitações

- Não compartilhe `OPENAI_API_KEY` ou `RESEND_API_KEY`.
- O limite diário no código é básico; antes de divulgar amplamente, configure também limites de requisições no Cloudflare e monitore os custos da API.
- A pesquisa na web depende de uma chave OpenAI válida, do acesso ao modelo e da disponibilidade da ferramenta `web_search` na API. A lista de fontes é montada a partir das citações de URL retornadas pela API; revise as fontes e o relatório antes de entregar. A pesquisa bibliográfica não substitui resultados experimentais reais. Se a API não oferecer suporte à ferramenta, a geração retornará erro em vez de simular uma pesquisa.
- O DOCX é montado no navegador pela biblioteca `docx` carregada de uma CDN, então a geração do arquivo exige internet.
- Esta entrega é o pacote de código; não foi possível publicar na sua conta Cloudflare nem testar o envio de e-mail sem acesso às suas contas e respectivas chaves.
