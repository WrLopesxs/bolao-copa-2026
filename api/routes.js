/**
 * api/routes.js
 * Todas as rotas REST (versão async/Postgres, sem WebSocket).
 * Tempo real é feito por polling + heartbeat de presença no frontend.
 */
const express = require('express');
const crypto = require('node:crypto');
const { get, all, run, getSetting, setSetting } = require('../database/data');
const { hashPassword, verifyPassword, createToken, requireAuth, requireAdmin } = require('../backend/auth');
const { calcPoints, scoreMatch, rescoreAll, getRanking, POINTS } = require('../backend/scoring');
const { syncResults, syncIfStale } = require('./football-api');
const { getVapid, saveSubscription, sendPush } = require('./push');

const { h, isLocked, publicMatch, validScore, lc, normTxt, rateLimit } = require('./helpers');
const teams = require('../database/teams.json');

const router = express.Router();

// Multi-tenant: grupos, convites e rotas escopadas por grupo
router.use(require('./groups'));
// Pagamentos (premium por grupo via Stripe)
router.use(require('./billing'));

// ======================================================== AUTENTICAÇÃO
router.post('/auth/register', rateLimit(10, 5 * 60_000), h(async (req, res) => {
  const { name, email, password, sector } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Informe nome, e-mail e senha.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  if (await get('SELECT id FROM users WHERE email = $1', [lc(email)]))
    return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  const { hash, salt } = hashPassword(String(password));
  const isFirst = (await get('SELECT COUNT(*)::int AS c FROM users')).c === 0;
  const row = await get(
    `INSERT INTO users (name, email, password_hash, salt, sector, is_admin)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [String(name).trim(), lc(email), hash, salt, String(sector || '').trim(), isFirst ? 1 : 0]
  );
  const user = await get('SELECT id, name, email, sector, photo, is_admin, created_at FROM users WHERE id = $1', [row.id]);
  res.json({ token: await createToken(row.id), user, firstUser: isFirst });
}));

router.post('/auth/login', rateLimit(15, 5 * 60_000), h(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await get('SELECT * FROM users WHERE email = $1', [lc(email)]);
  if (!user || !verifyPassword(String(password || ''), user.salt, user.password_hash))
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  const { password_hash, salt, reset_token, reset_expires, ...safe } = user;
  res.json({ token: await createToken(user.id), user: safe });
}));

router.post('/auth/forgot', rateLimit(10, 5 * 60_000), h(async (req, res) => {
  const user = await get('SELECT id FROM users WHERE email = $1', [lc(req.body?.email)]);
  if (user) {
    const code = crypto.randomInt(100000, 999999).toString();
    await run('UPDATE users SET reset_token=$1, reset_expires=$2 WHERE id=$3',
      [code, Date.now() + 3600_000, user.id]);
    console.log(`[Recuperação] Código para ${lc(req.body?.email)}: ${code}`);
  }
  res.json({ message: 'Se o e-mail existir, um código foi gerado. Peça ao administrador do bolão.' });
}));

router.post('/auth/reset', rateLimit(10, 5 * 60_000), h(async (req, res) => {
  const { email, code, password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });
  const user = await get('SELECT * FROM users WHERE email = $1', [lc(email)]);
  if (!user || user.reset_token !== String(code || '') || Number(user.reset_expires || 0) < Date.now())
    return res.status(400).json({ error: 'Código inválido ou expirado.' });
  const { hash, salt } = hashPassword(String(password));
  await run('UPDATE users SET password_hash=$1, salt=$2, reset_token=NULL, reset_expires=NULL WHERE id=$3',
    [hash, salt, user.id]);
  res.json({ message: 'Senha redefinida com sucesso. Faça login.' });
}));

router.get('/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.put('/auth/profile', requireAuth, h(async (req, res) => {
  const { name, sector, photo, password } = req.body || {};
  if (photo && String(photo).length > 500_000) return res.status(400).json({ error: 'Foto muito grande (máx. ~350KB).' });
  await run(
    `UPDATE users SET name=COALESCE($1,name), sector=COALESCE($2,sector), photo=COALESCE($3,photo) WHERE id=$4`,
    [name ?? null, sector ?? null, photo ?? null, req.user.id]
  );
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
    const { hash, salt } = hashPassword(String(password));
    await run('UPDATE users SET password_hash=$1, salt=$2 WHERE id=$3', [hash, salt, req.user.id]);
  }
  const user = await get('SELECT id, name, email, sector, photo, is_admin, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json({ user });
}));

// ============================================================ PRESENÇA
router.post('/heartbeat', requireAuth, h(async (req, res) => {
  await run(
    `INSERT INTO presence (user_id, last_seen) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET last_seen = now()`, [req.user.id]
  );
  res.json({ ok: true });
}));

// "Online agora", chat, ranking, dashboard e comparação de palpites são
// escopados por grupo — vivem em api/groups.js (/api/groups/:gid/...).

// ============================================================== JOGOS
router.get('/matches', requireAuth, h(async (req, res) => {
  syncIfStale(); // com jogo rolando, quem está na tela de palpites também puxa o placar
  const matches = await all('SELECT * FROM matches ORDER BY date_utc ASC, id ASC');
  const preds = await all('SELECT * FROM predictions WHERE user_id = $1', [req.user.id]);
  const byMatch = new Map(preds.map((p) => [p.match_id, p]));
  res.json({
    matches: matches.map((m) => ({
      ...publicMatch(m),
      my_prediction: byMatch.get(m.id)
        ? { home: byMatch.get(m.id).home_pred, away: byMatch.get(m.id).away_pred, points: byMatch.get(m.id).points }
        : null,
    })),
  });
}));

// ============================================================ PALPITES
router.post('/predictions', requireAuth, h(async (req, res) => {
  const matchId = Number(req.body?.match_id);
  const home = validScore(req.body?.home), away = validScore(req.body?.away);
  if (home === null || away === null) return res.status(400).json({ error: 'Placar inválido. Use números de 0 a 99.' });
  const match = await get('SELECT * FROM matches WHERE id = $1', [matchId]);
  if (!match) return res.status(404).json({ error: 'Jogo não encontrado.' });
  if (isLocked(match)) return res.status(403).json({ error: 'Palpites bloqueados: o jogo começa em menos de 1 hora.' });
  await run(`
    INSERT INTO predictions (user_id, match_id, home_pred, away_pred, updated_at)
    VALUES ($1,$2,$3,$4, now())
    ON CONFLICT (user_id, match_id)
    DO UPDATE SET home_pred=excluded.home_pred, away_pred=excluded.away_pred, updated_at=now()`,
    [req.user.id, matchId, home, away]);
  res.json({ ok: true, message: 'Palpite salvo!' });
}));

// ======================================================== NOTIFICAÇÕES
router.get('/push/key', requireAuth, h(async (req, res) => {
  res.json({ key: (await getVapid()).publicKey });
}));

router.post('/push/subscribe', requireAuth, h(async (req, res) => {
  const s = req.body || {};
  if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth)
    return res.status(400).json({ error: 'Assinatura de notificação inválida.' });
  await saveSubscription(req.user.id, s);
  res.json({ ok: true });
}));

// ==================================================== ADMIN DA PLATAFORMA
// (users.is_admin = dono da plataforma; admin de grupo vive em group_members)
router.get('/admin/users', requireAdmin, h(async (req, res) => {
  const users = await all(`
    SELECT id, name, email, sector, is_admin, created_at, reset_token, reset_expires,
           (SELECT COUNT(*)::int FROM predictions p WHERE p.user_id = users.id) AS predictions
      FROM users ORDER BY name`);
  res.json({ users: users.map((u) => ({ ...u, reset_token: Number(u.reset_expires || 0) > Date.now() ? u.reset_token : null })) });
}));

router.post('/admin/users', requireAdmin, h(async (req, res) => {
  const { name, email, password, sector, is_admin } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Informe nome, e-mail e senha.' });
  if (await get('SELECT id FROM users WHERE email = $1', [lc(email)])) return res.status(409).json({ error: 'E-mail já cadastrado.' });
  const { hash, salt } = hashPassword(String(password));
  await run('INSERT INTO users (name, email, password_hash, salt, sector, is_admin) VALUES ($1,$2,$3,$4,$5,$6)',
    [String(name).trim(), lc(email), hash, salt, String(sector || ''), is_admin ? 1 : 0]);
  res.json({ ok: true });
}));

router.delete('/admin/users/:id', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Você não pode remover a si mesmo.' });
  await run('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
}));

router.put('/admin/users/:id', requireAdmin, h(async (req, res) => {
  await run('UPDATE users SET is_admin = $1 WHERE id = $2', [req.body?.is_admin ? 1 : 0, Number(req.params.id)]);
  res.json({ ok: true });
}));

// O placar NÃO é editável nem pelo admin da plataforma (transparência com os
// grupos): resultados entram apenas pela sincronização automática (ESPN/API).
router.put('/admin/matches/:id', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  const match = await get('SELECT * FROM matches WHERE id = $1', [id]);
  if (!match) return res.status(404).json({ error: 'Jogo não encontrado.' });
  const b = req.body || {};
  const status = ['scheduled', 'live', 'finished'].includes(b.status) ? b.status : match.status;
  const lock_mode = ['auto', 'open', 'locked'].includes(b.lock_mode) ? b.lock_mode : match.lock_mode;
  await run(`
    UPDATE matches SET home_team=COALESCE($1,home_team), away_team=COALESCE($2,away_team),
      date_utc=COALESCE($3,date_utc), status=$4, lock_mode=$5
    WHERE id=$6`,
    [b.home_team || null, b.away_team || null, b.date_utc || null, status, lock_mode, id]);
  await rescoreAll();
  res.json({ ok: true });
}));

router.get('/admin/settings', requireAdmin, h(async (req, res) => {
  const key = await getSetting('api_football_key', '');
  res.json({ api_football_key: key ? `${key.slice(0, 4)}••••` : '', has_key: !!key });
}));
router.put('/admin/settings', requireAdmin, h(async (req, res) => {
  if (typeof req.body?.api_football_key === 'string') await setSetting('api_football_key', req.body.api_football_key.trim());
  res.json({ ok: true });
}));

// Envia uma notificação manual: só para o admin (teste) ou para todos
router.post('/admin/push-test', requireAdmin, h(async (req, res) => {
  const { title, body, everyone } = req.body || {};
  const payload = {
    title: String(title || '').trim() || '🔔 palpitei',
    body: String(body || '').trim() || 'Teste: as notificações estão funcionando!',
    url: '/#/dashboard',
    tag: 'aviso-' + Date.now(),
  };
  const ids = everyone
    ? (await all('SELECT DISTINCT user_id FROM push_subs')).map((r) => r.user_id)
    : [req.user.id];
  let devices = 0;
  for (const id of ids) {
    devices += (await get('SELECT COUNT(*)::int AS c FROM push_subs WHERE user_id = $1', [id])).c;
    await sendPush(id, payload);
  }
  res.json({ ok: true, users: ids.length, devices });
}));

// -------- palpites bônus: ver respostas e definir o gabarito (pontua na hora)
router.get('/admin/bonus', requireAdmin, h(async (req, res) => {
  const questions = await all('SELECT * FROM bonus_questions ORDER BY id');
  const answers = await all(`
    SELECT question_id, answer, COUNT(*)::int AS n
      FROM bonus_answers GROUP BY question_id, answer ORDER BY n DESC, answer`);
  res.json({
    questions: questions.map((q) => ({
      ...q, lock_at: q.lock_at instanceof Date ? q.lock_at.toISOString() : q.lock_at,
      options: q.options ? JSON.parse(q.options) : null,
    })),
    answers,
    teams: Object.entries(teams).map(([en, v]) => ({ en, pt: v.pt })).sort((a, b) => a.pt.localeCompare(b.pt, 'pt')),
  });
}));

router.put('/admin/bonus/:id', requireAdmin, h(async (req, res) => {
  const q = await get('SELECT * FROM bonus_questions WHERE id = $1', [Number(req.params.id)]);
  if (!q) return res.status(404).json({ error: 'Pergunta não encontrada.' });
  const ans = String(req.body?.correct_answer || '').trim();
  await run('UPDATE bonus_questions SET correct_answer = $1 WHERE id = $2', [ans || null, q.id]);
  if (!ans) { // gabarito removido: despontua
    await run('UPDATE bonus_answers SET points = NULL WHERE question_id = $1', [q.id]);
    return res.json({ ok: true, scored: 0 });
  }
  // team/choice: igualdade exata; texto: comparação sem acento/caixa
  const rows = await all('SELECT user_id, answer FROM bonus_answers WHERE question_id = $1', [q.id]);
  for (const r of rows) {
    const hit = q.qtype === 'text' ? normTxt(r.answer) === normTxt(ans) : r.answer === ans;
    await run('UPDATE bonus_answers SET points = $1 WHERE question_id = $2 AND user_id = $3',
      [hit ? q.points : 0, q.id, r.user_id]);
  }
  res.json({ ok: true, scored: rows.length });
}));

router.post('/admin/sync', requireAdmin, h(async (req, res) => {
  res.json({ ok: true, changed: await syncResults() });
}));

router.get('/admin/export', requireAdmin, h(async (req, res) => {
  const ranking = await getRanking();
  const sep = ';';
  const lines = [
    ['Posição', 'Nome', 'Setor', 'Pontos', 'Acertos exatos', 'Palpites com pontos', 'Total de palpites'].join(sep),
    ...ranking.map((r) => [r.position, `"${r.name}"`, `"${r.sector || ''}"`, r.total_points, r.exact_hits, r.scoring_hits, r.total_predictions].join(sep)),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ranking-bolao.csv"');
  res.send('﻿' + lines.join('\r\n'));
}));

// ============================================================== CRON
// Chamado pelo Cron da Vercel (ou manualmente). Protegido por CRON_SECRET.
router.get('/cron/sync', h(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.key;
  if (secret && provided !== secret) return res.status(401).json({ error: 'não autorizado' });
  res.json({ ok: true, changed: await syncResults() });
}));

module.exports = router;
