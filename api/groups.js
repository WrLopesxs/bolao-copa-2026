/**
 * api/groups.js
 * Multi-tenant: grupos de bolão, convites, membros e as rotas escopadas
 * por grupo (dashboard, ranking, chat, online, comparação de palpites).
 *
 * Regra de ouro: nenhuma consulta que mostre PESSOAS sai daqui sem filtrar
 * por group_members. Jogos e palpites são globais (palpite único por usuário);
 * o que muda entre grupos é quem aparece.
 */
const express = require('express');
const { get, all, run, genInviteCode } = require('../database/data');
const { requireAuth } = require('../backend/auth');
const { getRanking, POINTS } = require('../backend/scoring');
const { sendPush } = require('./push');
const { syncIfStale, scoreUnscored } = require('./football-api');
const { h, isLocked, publicMatch, rateLimit } = require('./helpers');

const router = express.Router();

const FREE_GROUPS_PER_USER = 3;   // anti-spam: grupos criados por usuário free
const FREE_MAX_MEMBERS = 10;      // limite de participantes no plano free

// ------------------------------------------------------------ helpers
const RESERVED_SLUGS = ['admin', 'api', 'app', 'invite', 'grupo', 'grupos', 'login', 'cadastro', 'www', 'palpitei', 'sobre', 'planos'];

function slugify(name) {
  const s = String(name).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // remove acentos (ã -> a)
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'grupo';
}
async function uniqueSlug(name) {
  let base = slugify(name);
  if (RESERVED_SLUGS.includes(base)) base = base + '-grupo';
  let slug = base, n = 1;
  while (await get('SELECT id FROM groups WHERE slug = $1', [slug])) slug = `${base}-${++n}`;
  return slug;
}
async function uniqueInviteCode() {
  let code = genInviteCode();
  while (await get('SELECT id FROM groups WHERE invite_code = $1', [code])) code = genInviteCode();
  return code;
}
const validColor = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? c : '';

/** Visão do grupo sem o código de convite (só admins do grupo recebem o código). */
function groupView(g, { role = null, members = null, withCode = false } = {}) {
  const { invite_code, ...rest } = g;
  const out = { ...rest, my_role: role, member_count: members };
  if (withCode) out.invite_code = invite_code;
  return out;
}

const ROLE_RANK = { member: 0, admin: 1, owner: 2 };

/** Carrega o grupo e a participação do usuário; barra quem não é membro. */
const requireMember = h(async (req, res, next) => {
  const gid = Number(req.params.gid);
  if (!Number.isInteger(gid) || gid <= 0) return res.status(400).json({ error: 'Grupo inválido.' });
  const g = await get('SELECT * FROM groups WHERE id = $1', [gid]);
  if (!g) return res.status(404).json({ error: 'Grupo não encontrado.' });
  if (g.is_suspended) return res.status(403).json({ error: 'Este grupo está suspenso.' });
  const m = await get('SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2', [gid, req.user.id]);
  // admin da plataforma pode inspecionar qualquer grupo (suporte)
  if (!m && !req.user.is_admin) return res.status(403).json({ error: 'Você não participa deste grupo.' });
  req.group = g;
  req.membership = m || { role: 'owner', platform: true };
  next();
});

/** Exige papel mínimo no grupo (admin do grupo = admin ou owner). */
const requireRole = (min) => (req, res, next) => {
  if (ROLE_RANK[req.membership.role] < ROLE_RANK[min])
    return res.status(403).json({ error: 'Apenas administradores do grupo podem fazer isso.' });
  next();
};

const memberCount = async (gid) =>
  (await get('SELECT COUNT(*)::int AS c FROM group_members WHERE group_id = $1', [gid])).c;

/** Exige grupo premium (recursos pagos). */
const requirePremium = (req, res, next) => {
  if (req.group.plan !== 'premium')
    return res.status(403).json({ error: 'Recurso exclusivo de grupos premium. ⭐', premium_required: true });
  next();
};

// ============================================================ CONVITES
// Preview público do convite (aparece antes do login/cadastro).
router.get('/invite/:code', rateLimit(30, 5 * 60_000), h(async (req, res) => {
  const g = await get('SELECT * FROM groups WHERE invite_code = $1', [String(req.params.code).toUpperCase().trim()]);
  if (!g || g.is_suspended) return res.status(404).json({ error: 'Convite inválido ou expirado.' });
  res.json({
    group: {
      name: g.name, description: g.description, logo: g.logo,
      color_primary: g.color_primary, member_count: await memberCount(g.id),
    },
  });
}));

router.post('/invite/:code/join', requireAuth, rateLimit(20, 5 * 60_000), h(async (req, res) => {
  const g = await get('SELECT * FROM groups WHERE invite_code = $1', [String(req.params.code).toUpperCase().trim()]);
  if (!g || g.is_suspended) return res.status(404).json({ error: 'Convite inválido ou expirado.' });
  const already = await get('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [g.id, req.user.id]);
  if (!already) {
    const count = await memberCount(g.id);
    if (g.max_members != null && count >= g.max_members)
      return res.status(403).json({ error: `Este grupo atingiu o limite de ${g.max_members} participantes do plano gratuito. Peça ao dono do grupo para ativar o premium. ⭐` });
    await run('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [g.id, req.user.id, 'member']);
  }
  res.json({ ok: true, group: groupView(g, { role: already ? undefined : 'member' }) });
}));

// ============================================================== GRUPOS
router.post('/groups', requireAuth, rateLimit(10, 60 * 60_000), h(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (name.length < 3 || name.length > 60)
    return res.status(400).json({ error: 'O nome do grupo deve ter entre 3 e 60 caracteres.' });
  const description = String(req.body?.description || '').trim().slice(0, 300);
  const created = (await get('SELECT COUNT(*)::int AS c FROM groups WHERE creator_id = $1', [req.user.id])).c;
  if (created >= FREE_GROUPS_PER_USER && !req.user.is_admin)
    return res.status(403).json({ error: `Você já criou ${FREE_GROUPS_PER_USER} grupos (limite do plano gratuito).` });

  const slug = await uniqueSlug(name);
  const code = await uniqueInviteCode();
  const row = await get(
    `INSERT INTO groups (name, slug, description, color_primary, color_secondary, invite_code, competition_id, creator_id, max_members)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8) RETURNING *`,
    [name, slug, description, validColor(req.body?.color_primary), validColor(req.body?.color_secondary),
     code, req.user.id, FREE_MAX_MEMBERS]
  );
  await run('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [row.id, req.user.id, 'owner']);
  res.json({ group: groupView(row, { role: 'owner', members: 1, withCode: true }) });
}));

// Meus grupos (com papel e nº de participantes)
router.get('/groups', requireAuth, h(async (req, res) => {
  const rows = await all(`
    SELECT g.*, gm.role AS my_role,
           (SELECT COUNT(*)::int FROM group_members x WHERE x.group_id = g.id) AS member_count
      FROM group_members gm JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_id = $1 AND g.is_suspended = 0
     ORDER BY gm.joined_at ASC`, [req.user.id]);
  res.json({
    groups: rows.map((g) => groupView(g, {
      role: g.my_role, members: g.member_count,
      withCode: ROLE_RANK[g.my_role] >= ROLE_RANK.admin,
    })),
  });
}));

router.get('/groups/:gid', requireAuth, requireMember, h(async (req, res) => {
  res.json({
    group: groupView(req.group, {
      role: req.membership.role,
      members: await memberCount(req.group.id),
      withCode: ROLE_RANK[req.membership.role] >= ROLE_RANK.admin,
    }),
  });
}));

// Editar identidade do grupo (admin do grupo)
router.put('/groups/:gid', requireAuth, requireMember, requireRole('admin'), h(async (req, res) => {
  const b = req.body || {};
  if (b.logo && req.group.plan !== 'premium')
    return res.status(403).json({ error: 'Logo personalizada é um recurso premium. ⭐' });
  if (b.logo && String(b.logo).length > 500_000) return res.status(400).json({ error: 'Logo muito grande (máx. ~350KB).' });
  const name = b.name != null ? String(b.name).trim() : null;
  if (name != null && (name.length < 3 || name.length > 60))
    return res.status(400).json({ error: 'O nome do grupo deve ter entre 3 e 60 caracteres.' });
  // pontuação personalizada (premium): inteiro 0..100; string vazia volta ao padrão
  const customPts = (v) => {
    if (v === '' || v === undefined) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
  };
  const hasCustom = ['points_exact', 'points_outcome', 'points_goals'].some((k) => k in b);
  if (hasCustom && req.group.plan !== 'premium')
    return res.status(403).json({ error: 'Pontuação personalizada é um recurso premium. ⭐' });
  await run(
    `UPDATE groups SET
       name = COALESCE($1, name),
       description = COALESCE($2, description),
       logo = COALESCE($3, logo),
       color_primary = COALESCE($4, color_primary),
       color_secondary = COALESCE($5, color_secondary)
     WHERE id = $6`,
    [name, b.description != null ? String(b.description).slice(0, 300) : null,
     b.logo != null ? String(b.logo) : null,
     b.color_primary != null ? validColor(b.color_primary) : null,
     b.color_secondary != null ? validColor(b.color_secondary) : null,
     req.group.id]
  );
  if (hasCustom) {
    const ex = customPts(b.points_exact), ou = customPts(b.points_outcome), gl = customPts(b.points_goals);
    // se a regra é igual à padrão, limpa (volta a usar os pontos gravados)
    const isDefault = (ex ?? 10) === 10 && (ou ?? 5) === 5 && (gl ?? 2) === 2;
    await run('UPDATE groups SET points_exact=$1, points_outcome=$2, points_goals=$3 WHERE id=$4',
      isDefault ? [null, null, null, req.group.id] : [ex ?? 10, ou ?? 5, gl ?? 2, req.group.id]);
  }
  const g = await get('SELECT * FROM groups WHERE id = $1', [req.group.id]);
  res.json({ group: groupView(g, { role: req.membership.role, withCode: true }) });
}));

// Gera um código de convite novo (invalida o anterior)
router.post('/groups/:gid/invite', requireAuth, requireMember, requireRole('admin'), h(async (req, res) => {
  const code = await uniqueInviteCode();
  await run('UPDATE groups SET invite_code = $1 WHERE id = $2', [code, req.group.id]);
  res.json({ invite_code: code });
}));

// ============================================================= MEMBROS
router.get('/groups/:gid/members', requireAuth, requireMember, h(async (req, res) => {
  const members = await all(`
    SELECT u.id, u.name, u.photo, u.sector, gm.role, gm.title, gm.joined_at
      FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1
     ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`,
    [req.group.id]);
  res.json({ members });
}));

// Sair do grupo (qualquer membro, exceto o dono) ou remover membro (admin do grupo)
router.delete('/groups/:gid/members/:uid', requireAuth, requireMember, h(async (req, res) => {
  const uid = Number(req.params.uid);
  const target = await get('SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2', [req.group.id, uid]);
  if (!target) return res.status(404).json({ error: 'Membro não encontrado.' });
  if (target.role === 'owner') return res.status(400).json({ error: 'O dono não pode sair do próprio grupo.' });
  const me = req.membership;
  const isSelf = uid === req.user.id;
  if (!isSelf && (ROLE_RANK[me.role] < ROLE_RANK.admin || ROLE_RANK[target.role] >= ROLE_RANK[me.role]))
    return res.status(403).json({ error: 'Sem permissão para remover este membro.' });
  await run('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [req.group.id, uid]);
  res.json({ ok: true });
}));

// Promover/rebaixar membro (dono) ou definir apelido de zoeira
// (cada um define o próprio; o dono pode moderar o de qualquer um)
router.put('/groups/:gid/members/:uid', requireAuth, requireMember, h(async (req, res) => {
  const uid = Number(req.params.uid);
  const target = await get('SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2', [req.group.id, uid]);
  if (!target) return res.status(404).json({ error: 'Membro não encontrado.' });

  if ('title' in (req.body || {})) { // apelido personalizado (premium)
    if (req.group.plan !== 'premium')
      return res.status(403).json({ error: 'Apelidos personalizados são um recurso premium. ⭐' });
    if (uid !== req.user.id && req.membership.role !== 'owner')
      return res.status(403).json({ error: 'Você só pode mudar o seu próprio apelido.' });
    const title = String(req.body.title || '').trim().slice(0, 24);
    await run('UPDATE group_members SET title = $1 WHERE group_id = $2 AND user_id = $3', [title, req.group.id, uid]);
    return res.json({ ok: true });
  }

  if (req.membership.role !== 'owner')
    return res.status(403).json({ error: 'Apenas o dono pode alterar papéis.' });
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  if (target.role === 'owner') return res.status(400).json({ error: 'O papel do dono não pode ser alterado.' });
  await run('UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3', [role, req.group.id, uid]);
  res.json({ ok: true });
}));

// ================================================= ROTAS ESCOPADAS
router.get('/groups/:gid/online', requireAuth, requireMember, h(async (req, res) => {
  const online = await all(`
    SELECT u.id, u.name, u.photo, u.sector
      FROM presence p
      JOIN users u ON u.id = p.user_id
      JOIN group_members gm ON gm.user_id = u.id AND gm.group_id = $1
     WHERE p.last_seen > now() - interval '45 seconds'
     ORDER BY u.name`, [req.group.id]);
  res.json({ online });
}));

router.get('/groups/:gid/chat', requireAuth, requireMember, h(async (req, res) => {
  const after = Number(req.query.after) || 0;
  const messages = after > 0
    ? await all(`
        SELECT c.id, c.text, c.created_at, u.id AS user_id, u.name, u.photo
          FROM chat_messages c JOIN users u ON u.id = c.user_id
         WHERE c.group_id = $1 AND c.id > $2 ORDER BY c.id ASC LIMIT 200`, [req.group.id, after])
    : (await all(`
        SELECT c.id, c.text, c.created_at, u.id AS user_id, u.name, u.photo
          FROM chat_messages c JOIN users u ON u.id = c.user_id
         WHERE c.group_id = $1 ORDER BY c.id DESC LIMIT 50`, [req.group.id])).reverse();
  res.json({ messages });
}));

router.post('/groups/:gid/chat', requireAuth, requireMember, h(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Mensagem vazia.' });
  if (text.length > 500) return res.status(400).json({ error: 'Mensagem muito longa (máx. 500 caracteres).' });
  const row = await get(
    'INSERT INTO chat_messages (user_id, group_id, text) VALUES ($1, $2, $3) RETURNING id',
    [req.user.id, req.group.id, text]);
  res.json({ ok: true, id: row.id });
}));

router.get('/groups/:gid/ranking', requireAuth, requireMember, h(async (req, res) => {
  res.json({
    ranking: await getRanking(req.query.stage || null, req.group),
    points_table: {
      EXACT: req.group.points_exact ?? POINTS.EXACT,
      OUTCOME: req.group.points_outcome ?? POINTS.OUTCOME,
      TEAM_GOALS: req.group.points_goals ?? POINTS.TEAM_GOALS,
    },
  });
}));

router.get('/groups/:gid/dashboard', requireAuth, requireMember, h(async (req, res) => {
  syncIfStale(); // dispara sync de resultados em background
  // rede de segurança: pontua na hora qualquer jogo encerrado que tenha
  // ficado com palpites em branco (ex.: falha parcial numa pontuação anterior)
  await scoreUnscored().catch((e) => console.error('[failsafe]', e.message));
  const premium = req.group.plan === 'premium';
  if (premium) await ensureRoundChampions(req.group).catch((e) => console.error('[rodada]', e.message));
  const ranking = await getRanking(null, req.group);
  const me = ranking.find((r) => r.id === req.user.id) || null;

  const upcoming = (await all(`SELECT * FROM matches WHERE status='scheduled' AND date_utc > now() ORDER BY date_utc ASC LIMIT 6`)).map(publicMatch);
  const live = (await all(`SELECT * FROM matches WHERE status='live' ORDER BY date_utc ASC`)).map(publicMatch);
  const recent = (await all(`SELECT * FROM matches WHERE status='finished' ORDER BY date_utc DESC LIMIT 6`)).map(publicMatch);

  const history = await all(`
    SELECT h.points, m.date_utc, m.home_team, m.away_team
      FROM score_history h JOIN matches m ON m.id = h.match_id
     WHERE h.user_id = $1 ORDER BY m.date_utc ASC`, [req.user.id]);
  let acc = 0;
  const evolution = history.map((x) => ({
    date: x.date_utc instanceof Date ? x.date_utc.toISOString() : x.date_utc,
    label: `${x.home_team} x ${x.away_team}`, points: x.points, total: (acc += x.points),
  }));

  // extra premium: campeão da última rodada
  let round_champion = null;
  if (premium) {
    round_champion = await get(`
      SELECT rc.day, rc.points, u.id AS user_id, u.name, u.photo
        FROM round_champions rc JOIN users u ON u.id = rc.user_id
       WHERE rc.group_id = $1 ORDER BY rc.day DESC LIMIT 1`, [req.group.id]);
  }

  res.json({
    me, top10: ranking.slice(0, 10), upcoming, live, recent, evolution,
    total_users: ranking.length, premium, round_champion,
  });
}));

// Comparação de palpites: só os palpites de quem é do grupo
router.get('/groups/:gid/matches/:mid/predictions', requireAuth, requireMember, h(async (req, res) => {
  // garante que jogos encerrados estejam pontuados antes de mostrar a comparação
  // (o "–" some na hora se algum palpite tinha ficado órfão)
  await scoreUnscored().catch((e) => console.error('[failsafe]', e.message));
  const match = await get('SELECT * FROM matches WHERE id = $1', [Number(req.params.mid)]);
  if (!match) return res.status(404).json({ error: 'Jogo não encontrado.' });
  const locked = isLocked(match);
  let predictions = [];
  if (locked) {
    // updated_at = auditoria anti-mamata (mostrado em grupos premium)
    predictions = await all(`
      SELECT p.home_pred, p.away_pred, p.points, p.updated_at, u.id AS user_id, u.name, u.photo
        FROM predictions p
        JOIN users u ON u.id = p.user_id
        JOIN group_members gm ON gm.user_id = u.id AND gm.group_id = $2
       WHERE p.match_id = $1 ORDER BY p.points DESC NULLS LAST, u.name ASC`, [match.id, req.group.id]);
  } else {
    predictions = await all(`
      SELECT p.home_pred, p.away_pred, p.points, u.id AS user_id, u.name, u.photo
        FROM predictions p JOIN users u ON u.id = p.user_id
       WHERE p.match_id = $1 AND p.user_id = $2`, [match.id, req.user.id]);
  }
  res.json({ match: publicMatch(match), locked, predictions });
}));

// ===================================== CAMPEÃO DA RODADA (premium)
/**
 * Para cada dia (UTC) em que TODOS os jogos terminaram e o grupo ainda não
 * tem campeão registrado, calcula o vencedor, grava e avisa por push.
 * Chamado de forma preguiçosa quando alguém abre o dashboard do grupo.
 */
async function ensureRoundChampions(group) {
  const days = await all(`
    SELECT DISTINCT (m.date_utc AT TIME ZONE 'UTC')::date AS day
      FROM matches m
     WHERE m.status = 'finished'
       AND NOT EXISTS (SELECT 1 FROM round_champions rc
                        WHERE rc.group_id = $1 AND rc.day = (m.date_utc AT TIME ZONE 'UTC')::date)
       AND NOT EXISTS (SELECT 1 FROM matches m2
                        WHERE (m2.date_utc AT TIME ZONE 'UTC')::date = (m.date_utc AT TIME ZONE 'UTC')::date
                          AND m2.status <> 'finished')
     ORDER BY day`, [group.id]);
  for (const row of days) {
    const day = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
    const top = await get(`
      SELECT h.user_id, SUM(h.points)::int AS pts
        FROM score_history h
        JOIN matches m ON m.id = h.match_id AND (m.date_utc AT TIME ZONE 'UTC')::date = $2::date
        JOIN group_members gm ON gm.user_id = h.user_id AND gm.group_id = $1
       GROUP BY h.user_id HAVING SUM(h.points) > 0
       ORDER BY pts DESC LIMIT 1`, [group.id, day]);
    if (!top) continue; // ninguém pontuou nesse dia
    await run(`INSERT INTO round_champions (group_id, day, user_id, points)
               VALUES ($1,$2,$3,$4) ON CONFLICT (group_id, day) DO NOTHING`,
      [group.id, day, top.user_id, top.pts]);
    const u = await get('SELECT name FROM users WHERE id = $1', [top.user_id]);
    const [, mm, dd] = day.split('-');
    const ids = (await all('SELECT user_id FROM group_members WHERE group_id = $1', [group.id])).map((r) => r.user_id);
    for (const id of ids) {
      await sendPush(id, {
        title: `🏆 ${group.name}`,
        body: `${u.name} foi o campeão da rodada de ${dd}/${mm} com ${top.pts} pontos!`,
        url: '/#/dashboard',
        tag: `rodada-${group.id}-${day}`,
      }).catch(() => {});
    }
  }
}

// =============================================== RAIO-X DO GRUPO (premium)
router.get('/groups/:gid/stats', requireAuth, requireMember, requirePremium, h(async (req, res) => {
  const gid = req.group.id;
  const members = await all(`
    SELECT u.id, u.name, u.photo, gm.title
      FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1`, [gid]);

  // pontos por jogo encerrado de cada membro (score_history guarda inclusive 0)
  const hist = await all(`
    SELECT h.user_id, h.points, h.match_id, (m.date_utc AT TIME ZONE 'UTC')::date AS day
      FROM score_history h
      JOIN matches m ON m.id = h.match_id
      JOIN group_members gm ON gm.user_id = h.user_id AND gm.group_id = $1
     ORDER BY m.date_utc ASC, h.match_id ASC`, [gid]);

  const byUser = new Map(members.map((m) => [m.id, {
    ...m, total: 0, exacts: 0, zeros: 0, scoring: 0, played: 0,
    bestDay: null, bestDayPts: 0, zebras: 0, days: new Map(),
  }]));

  // quantos do grupo pontuaram em cada jogo (para achar a "zebra")
  const matchScorers = new Map(); // match_id -> {scored, total}
  for (const h of hist) {
    const s = matchScorers.get(h.match_id) || { scored: 0, total: 0 };
    s.total++; if (h.points > 0) s.scored++;
    matchScorers.set(h.match_id, s);
  }

  for (const hRow of hist) {
    const u = byUser.get(hRow.user_id);
    if (!u) continue;
    const day = hRow.day instanceof Date ? hRow.day.toISOString().slice(0, 10) : String(hRow.day).slice(0, 10);
    u.played++; u.total += hRow.points;
    if (hRow.points === 10) u.exacts++;
    if (hRow.points > 0) u.scoring++; else u.zeros++;
    u.days.set(day, (u.days.get(day) || 0) + hRow.points);
    const ms = matchScorers.get(hRow.match_id);
    // zebra: pontuou num jogo em que no máximo 1/4 do grupo pontuou (e tem gente suficiente)
    if (hRow.points > 0 && ms.total >= 4 && ms.scored / ms.total <= 0.25) u.zebras++;
  }

  const stats = [...byUser.values()].map((u) => {
    for (const [day, pts] of u.days) if (pts > u.bestDayPts) { u.bestDayPts = pts; u.bestDay = day; }
    const { days, ...rest } = u;
    return {
      ...rest,
      accuracy: u.played ? Math.round((u.scoring / u.played) * 100) : 0,
      // série acumulada para o gráfico "corrida pelo título"
      evolution: [...days.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
        .reduce((acc, [day, pts]) => { acc.push({ day, total: (acc.at(-1)?.total || 0) + pts }); return acc; }, []),
    };
  }).sort((a, b) => b.total - a.total);

  const champions = await all(`
    SELECT rc.day, rc.points, u.id AS user_id, u.name, u.photo
      FROM round_champions rc JOIN users u ON u.id = rc.user_id
     WHERE rc.group_id = $1 ORDER BY rc.day DESC LIMIT 20`, [gid]);

  res.json({ stats, champions });
}));

// Exportar ranking do grupo em CSV (admin do grupo)
router.get('/groups/:gid/export', requireAuth, requireMember, requireRole('admin'), h(async (req, res) => {
  if (req.group.plan !== 'premium')
    return res.status(403).json({ error: 'Exportação para Excel é um recurso premium. ⭐' });
  const ranking = await getRanking(null, req.group);
  const sep = ';';
  const clean = (s) => `"${String(s || '').replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}"`; // anti CSV injection
  const lines = [
    ['Posição', 'Nome', 'Setor', 'Pontos', 'Acertos exatos', 'Palpites com pontos', 'Total de palpites'].join(sep),
    ...ranking.map((r) => [r.position, clean(r.name), clean(r.sector), r.total_points, r.exact_hits, r.scoring_hits, r.total_predictions].join(sep)),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ranking-bolao.csv"');
  res.send('﻿' + lines.join('\r\n'));
}));

// Aviso push para os membros do grupo (admin do grupo)
router.post('/groups/:gid/notify', requireAuth, requireMember, requireRole('admin'), rateLimit(10, 60 * 60_000), h(async (req, res) => {
  const payload = {
    title: String(req.body?.title || '').trim().slice(0, 80) || `🔔 ${req.group.name}`,
    body: String(req.body?.body || '').trim().slice(0, 300) || 'Aviso do administrador do grupo.',
    url: '/#/dashboard',
    tag: `grupo-${req.group.id}-${Date.now()}`,
  };
  const ids = (await all('SELECT user_id FROM group_members WHERE group_id = $1', [req.group.id])).map((r) => r.user_id);
  let devices = 0;
  for (const id of ids) {
    devices += (await get('SELECT COUNT(*)::int AS c FROM push_subs WHERE user_id = $1', [id])).c;
    await sendPush(id, payload);
  }
  res.json({ ok: true, users: ids.length, devices });
}));

module.exports = router;
