/**
 * api/app.js
 * Constrói a aplicação Express (API + frontend estático).
 * É usada tanto pelo servidor local (backend/server.js) quanto pela
 * função serverless da Vercel (api/index.js). NÃO chama listen aqui.
 */
const path = require('node:path');
const express = require('express');
const { ensureReady } = require('../database/data');
const routes = require('./routes');

const app = express();
// rawBody é necessário para verificar a assinatura do webhook da Stripe
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// Garante schema + jogos carregados antes de qualquer rota da API
app.use('/api', (req, res, next) => {
  ensureReady().then(() => next()).catch(next);
}, routes);

// Frontend estático
const FRONTEND = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

// Erros
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

module.exports = app;
