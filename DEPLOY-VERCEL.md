# Publicar o Bolão na Vercel (24h no ar, link fixo, grátis)

Tempo estimado: ~15 minutos. Tudo no plano gratuito. Você vai criar 3 contas grátis (GitHub, Vercel e Neon) — eu já deixei o código pronto.

> Por que precisa do Neon? A Vercel não guarda arquivos (o banco SQLite some a cada atualização). O Neon é um Postgres gratuito que guarda os dados de verdade. O código já está preparado para ele.

---

## Passo 1 — Subir o código no GitHub

1. Crie uma conta em https://github.com (se ainda não tiver).
2. Crie um repositório novo: botão **New** → nome `bolao-copa-2026` → deixe **Private** → **Create repository**.
3. No seu PC, abra o terminal na pasta do projeto e rode (troque `SEU-USUARIO`):

   ```bash
   git init
   git add .
   git commit -m "Bolao Copa 2026"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/bolao-copa-2026.git
   git push -u origin main
   ```

   (O Git pode pedir login do GitHub na primeira vez.)

---

## Passo 2 — Criar o banco Postgres no Neon

1. Entre em https://neon.tech e clique em **Sign up** (pode entrar com a conta do GitHub).
2. Crie um projeto (qualquer nome, ex.: `bolao`). Região: escolha **AWS / São Paulo** se aparecer.
3. Na tela do projeto, procure **Connection string** e copie a URL que começa com `postgres://...` (a versão "pooled", com `-pooler`, é a recomendada).
4. Guarde essa URL — você vai colar na Vercel no próximo passo.

---

## Passo 3 — Publicar na Vercel

1. Entre em https://vercel.com e faça **Sign up** com a conta do GitHub.
2. Clique em **Add New… → Project** e **importe** o repositório `bolao-copa-2026`.
3. Antes de clicar em Deploy, abra **Environment Variables** e adicione:

   | Nome | Valor |
   |------|-------|
   | `DATABASE_URL` | a URL do Neon que você copiou |
   | `JWT_SECRET` | uma frase longa e aleatória (ex.: invente 30+ caracteres) |
   | `API_FOOTBALL_KEY` | sua chave da API-Football (opcional — dá para cadastrar depois no painel) |

4. Clique em **Deploy** e aguarde ~1 minuto.
5. A Vercel te dá um link tipo `https://bolao-copa-2026.vercel.app`. **Esse é o link fixo** para mandar aos colegas.

---

## Passo 4 — Primeiro acesso

1. Abra o link e **cadastre-se primeiro** — você vira o administrador.
2. Em **Admin → Configurações**, cole a chave da API-Football (se não fez no passo 3) e clique em **Sincronizar agora**.
3. Pronto. Mande o link para o setor.

---

## Como funciona o "tempo real" na Vercel

Como a Vercel não mantém conexões abertas, o site se atualiza sozinho a cada ~15 segundos (ranking, presença, resultados). A lista de "Online agora" mostra quem esteve ativo nos últimos 45 segundos. Os resultados da API são buscados automaticamente quando alguém abre o painel (no máximo uma busca a cada 15 min, para respeitar a cota grátis de 100/dia).

## Atualizar o site depois

Qualquer mudança: salve os arquivos, rode `git add . && git commit -m "ajustes" && git push`. A Vercel publica sozinha em ~1 min. Os dados no Neon **não se perdem** nas atualizações.

## Dúvidas comuns

- **O Neon "dorme"?** No plano grátis ele suspende após inatividade e acorda em ~1s na primeira visita. Os dados continuam salvos.
- **Posso continuar rodando no PC também?** Sim. Sem `DATABASE_URL`, o `npm start` usa um banco embutido local. São dois ambientes separados (PC e Vercel), cada um com seus dados.
- **Esqueci a senha de admin.** Veja `recuperar-admin.js` — funciona no banco local. Na Vercel, use a recuperação por código (aparece nos logs da função em vercel.com).
