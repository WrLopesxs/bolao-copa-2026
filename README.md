# ⚽ Bolão Copa do Mundo 2026

Sistema completo de bolão para o setor: palpites, pontuação automática, ranking em tempo real, presença online e painel administrativo. Já vem com a tabela oficial dos 104 jogos da Copa 2026.

Roda em **dois ambientes** sem mudar nada no código:

- **No seu PC** (`npm start`): usa um Postgres embutido (PGlite), sem instalar banco. Dados salvos em `database/pgdata`.
- **Na Vercel** (24h no ar, link fixo): usa Postgres do Neon. Veja **DEPLOY-VERCEL.md**.

## Rodar no PC

Requisito: Node.js 18+ ([nodejs.org](https://nodejs.org)).

```bash
npm install
npm start        # http://localhost:3000
```

O **primeiro usuário cadastrado vira administrador**. Cadastre-se antes de divulgar o link.

Para compartilhar pela internet sem depender de hospedagem, use o `iniciar-bolao.bat` (sobe o servidor + túnel Cloudflare grátis).

## Publicar na Vercel (recomendado para uso 24h)

Passo a passo completo em **DEPLOY-VERCEL.md**. Resumo: subir no GitHub → criar Postgres grátis no Neon → importar na Vercel com as variáveis `DATABASE_URL` e `JWT_SECRET`. Link fixo, dados nunca se perdem.

## Estrutura

```
api/        app.js (Express), index.js (entrada Vercel), routes.js, football-api.js
backend/    server.js (entrada local), auth.js, scoring.js
database/   data.js (Postgres/PGlite), seed.js, matches-2026.json, teams.json
frontend/   index.html, css/, js/
```

## Regras de pontuação

| Acerto | Pontos |
|---|---|
| Placar exato | **10** |
| Resultado correto (vitória/empate) | **5** |
| Gols de um dos times corretos | **2** (por time) |

Exemplo (real Brasil 2x1 Argentina): palpite 2x1 = 10; 2x0 = 7; 1x1 = 2. Ajustável em `backend/scoring.js`. Ao corrigir um resultado no admin, tudo é recalculado.

## Funcionalidades

Login, cadastro e recuperação de senha (código aparece no painel do admin — sem servidor de e-mail). Dashboard com posição, pontos, próximos jogos, resultados, gráfico de evolução, Top 10 e **presença online** (quem está conectado). Palpites com bloqueio automático 1h antes do jogo. Comparação de palpites por jogo (visível só após o bloqueio). Ranking geral e por fase com medalhas. Filtros de jogos. Painel admin: usuários, edição de jogos/resultados, liberar/bloquear palpites, chave da API-Football e export do ranking para Excel. Tema Copa, bandeiras, modo escuro e layout responsivo (mobile-first). **Notificações push no celular**: quando um resultado é lançado, quem pontuou recebe um aviso tipo "⚽ Você ganhou +10 pontos! Brasil 2 x 1 Argentina — você está em 3º lugar", mesmo com o site fechado (ative em **Perfil → Notificações**; no iPhone é preciso antes adicionar o site à Tela de Início).

## Resultados automáticos (API-Football)

Crie conta grátis em [dashboard.api-football.com](https://dashboard.api-football.com), e em **Admin → Configurações** cole a chave. O sistema busca os resultados sozinho (no máximo a cada 15 min, para respeitar a cota grátis de 100/dia), pontua e atualiza o ranking. Sem chave, o admin lança os resultados manualmente em **Admin → Jogos**.

## Tempo real

A interface se atualiza sozinha a cada ~15s (ranking, presença, resultados) e um "heartbeat" registra quem está online (ativos nos últimos 45s).

## Recuperar acesso de admin

Perdeu a senha do admin? Com o servidor fechado: `node recuperar-admin.js --listar` e depois `node recuperar-admin.js seu@email.com NovaSenha123`.
