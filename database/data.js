/**
 * database/data.js
 * Camada de acesso a dados (Postgres).
 *
 * - Em produção (Vercel): usa a variável de ambiente DATABASE_URL com o
 *   driver "pg" para se conectar a um Postgres gerenciado (Neon/Supabase).
 * - Em desenvolvimento local: se DATABASE_URL não estiver definida, usa o
 *   PGlite (Postgres embutido em WebAssembly), gravando em database/pgdata.
 *   Assim o projeto roda no seu PC sem instalar banco nenhum.
 *
 * Expõe helpers async: get (1 linha), all (várias), run (executa).
 */
const path = require('node:path');
const crypto = require('node:crypto');

const usePg = !!process.env.DATABASE_URL;
let pool = null;
let pglite = null;

if (usePg) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Neon/Supabase exigem SSL; defina PGSSL=disable para um Postgres local sem SSL
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 3,
  });
}

async function getPglite() {
  if (!pglite) {
    const { PGlite } = require('@electric-sql/pglite');
    pglite = new PGlite(path.join(__dirname, 'pgdata'));
    await pglite.waitReady;
  }
  return pglite;
}

/** Executa SQL com placeholders $1, $2... e devolve { rows }. */
async function query(text, params = []) {
  if (usePg) return pool.query(text, params);
  const db = await getPglite();
  return db.query(text, params);
}

const get = async (sql, params = []) => (await query(sql, params)).rows[0] || null;
const all = async (sql, params = []) => (await query(sql, params)).rows;
const run = async (sql, params = []) => query(sql, params);

/** Executa um bloco com VÁRIAS instruções (sem parâmetros), ex.: o schema. */
async function exec(sql) {
  if (usePg) return pool.query(sql);
  const db = await getPglite();
  return db.exec(sql); // PGlite aceita múltiplas instruções só via exec()
}

// ------------------------------------------------------------- schema
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,          -- sempre armazenado em minúsculas
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  sector        TEXT DEFAULT '',
  photo         TEXT DEFAULT '',
  is_admin      INTEGER DEFAULT 0,
  reset_token   TEXT,
  reset_expires BIGINT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  id          INTEGER PRIMARY KEY,
  stage       TEXT NOT NULL,
  round       INTEGER NOT NULL,
  group_name  TEXT,
  date_utc    TIMESTAMPTZ NOT NULL,
  location    TEXT DEFAULT '',
  home_team   TEXT NOT NULL,
  away_team   TEXT NOT NULL,
  home_score  INTEGER,
  away_score  INTEGER,
  status      TEXT DEFAULT 'scheduled',
  lock_mode   TEXT DEFAULT 'auto',
  api_fixture_id BIGINT
);

CREATE TABLE IF NOT EXISTS predictions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  home_pred  INTEGER NOT NULL,
  away_pred  INTEGER NOT NULL,
  points     INTEGER,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, match_id)
);

CREATE TABLE IF NOT EXISTS score_history (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  points     INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, match_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS presence (
  user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- competições (Copa 2026 é a nº 1; Brasileirão, Champions etc. no futuro)
CREATE TABLE IF NOT EXISTS competitions (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL,
  slug   TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'active'        -- upcoming | active | finished
);

-- grupos de bolão (multi-tenant): cada grupo é um bolão independente
CREATE TABLE IF NOT EXISTS groups (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  description     TEXT DEFAULT '',
  logo            TEXT DEFAULT '',     -- data-URL, como a foto de perfil
  banner          TEXT DEFAULT '',
  color_primary   TEXT DEFAULT '',
  color_secondary TEXT DEFAULT '',
  invite_code     TEXT UNIQUE NOT NULL,
  competition_id  INTEGER NOT NULL DEFAULT 1,
  plan            TEXT DEFAULT 'free', -- free | premium
  max_members     INTEGER DEFAULT 10,  -- NULL = ilimitado
  creator_id      INTEGER NOT NULL REFERENCES users(id),
  is_suspended    INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- participação: um usuário pode estar em vários grupos
CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- assinaturas de notificação push (um aparelho = uma linha)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- mensagens do chat do bolão
CREATE TABLE IF NOT EXISTS chat_messages (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- palpites bônus (campeão, artilheiro etc.) — perguntas da plataforma;
-- a resposta é global por usuário, mas os pontos só contam em grupo premium
CREATE TABLE IF NOT EXISTS bonus_questions (
  id             SERIAL PRIMARY KEY,
  competition_id INTEGER NOT NULL DEFAULT 1,
  qkey           TEXT UNIQUE NOT NULL,
  question       TEXT NOT NULL,
  qtype          TEXT NOT NULL,          -- team | choice | text
  options        TEXT DEFAULT '',        -- JSON (para qtype choice)
  points         INTEGER NOT NULL,
  lock_at        TIMESTAMPTZ NOT NULL,
  correct_answer TEXT
);

CREATE TABLE IF NOT EXISTS bonus_answers (
  question_id INTEGER NOT NULL REFERENCES bonus_questions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer      TEXT NOT NULL,
  points      INTEGER,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (question_id, user_id)
);

-- campeão da rodada (grupos premium): um vencedor por dia de jogos
CREATE TABLE IF NOT EXISTS round_champions (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points    INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (group_id, day)
);

-- pagamentos confirmados (premium por grupo); session_id único evita duplicar
CREATE TABLE IF NOT EXISTS payments (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     INTEGER,
  session_id  TEXT UNIQUE NOT NULL,
  amount      INTEGER NOT NULL,      -- em centavos
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- colunas novas em tabelas antigas (no-op quando já existem;
-- precisa vir depois dos CREATEs, que rodam na ordem do arquivo)
ALTER TABLE matches       ADD COLUMN IF NOT EXISTS competition_id INTEGER;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS group_id INTEGER;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS title TEXT DEFAULT '';
-- pontuação personalizada do grupo (premium); NULL = regra padrão 10/5/2
ALTER TABLE groups ADD COLUMN IF NOT EXISTS points_exact   INTEGER;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS points_outcome INTEGER;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS points_goals   INTEGER;

CREATE INDEX IF NOT EXISTS idx_pred_match ON predictions(match_id);
CREATE INDEX IF NOT EXISTS idx_pred_user  ON predictions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_id    ON chat_messages(id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_group ON chat_messages(group_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_gm_user    ON group_members(user_id);
`;

/** Código de convite curto, sem caracteres ambíguos (0/O, 1/I/L). */
function genInviteCode(len = 6) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len)).map((b) => chars[b % chars.length]).join('');
}

/**
 * Migração multi-tenant (idempotente, roda a cada cold start):
 * aponta os jogos para a competição 1 e, se o banco é de antes dos grupos
 * (tem usuários mas nenhum grupo), transforma o bolão existente no grupo #1
 * sem tocar em palpites nem pontos.
 */
async function migrateToGroups() {
  await run(`INSERT INTO competitions (id, name, slug, status)
             VALUES (1, 'Copa do Mundo 2026', 'copa-2026', 'active')
             ON CONFLICT (id) DO NOTHING`);
  await run(`SELECT setval('competitions_id_seq', (SELECT MAX(id) FROM competitions))`);
  await run(`UPDATE matches SET competition_id = 1 WHERE competition_id IS NULL`);

  // roda UMA vez na vida do banco (flag em settings): sem ela, um restart
  // futuro jogaria usuários novos sem grupo num grupo automático
  const migrated = await getSetting('groups_migrated');
  const hasGroups = (await get('SELECT COUNT(*)::int AS c FROM groups')).c > 0;
  const users = await all('SELECT id, is_admin FROM users ORDER BY id');
  if (!migrated && !hasGroups && users.length) {
    const owner = users.find((u) => u.is_admin) || users[0];
    await run(
      `INSERT INTO groups (id, name, slug, invite_code, competition_id, creator_id, plan, max_members)
       VALUES (1, 'Bolão Copa 2026', 'bolao-copa-2026', $1, 1, $2, 'premium', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [genInviteCode(), owner.id]
    );
    for (const u of users) {
      await run(
        `INSERT INTO group_members (group_id, user_id, role) VALUES (1, $1, $2)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [u.id, u.id === owner.id ? 'owner' : (u.is_admin ? 'admin' : 'member')]
      );
    }
    console.log(`[migração] Bolão existente virou o grupo #1 com ${users.length} membro(s).`);
  }
  if (!migrated) await setSetting('groups_migrated', '1');
  // alinha a sequência sem "queimar" o id 1 em bancos novos (is_called=false → próximo id é o próprio valor)
  await run(`SELECT setval('groups_id_seq', GREATEST((SELECT COALESCE(MAX(id),0) FROM groups), 1),
                    EXISTS(SELECT 1 FROM groups))`);
  await run(`UPDATE chat_messages SET group_id = 1 WHERE group_id IS NULL`);
  await seedBonusQuestions();
}

/** Perguntas bônus da Copa 2026 (travam antes do mata-mata começar). */
async function seedBonusQuestions() {
  const LOCK = '2026-06-28T00:00:00Z'; // véspera do mata-mata
  const QUESTIONS = [
    ['campeao',    'Quem será o campeão da Copa?',    'team',   '', 25],
    ['vice',       'Quem será o vice-campeão?',       'team',   '', 15],
    ['artilheiro', 'Quem será o artilheiro da Copa?', 'text',   '', 20],
    ['brasil',     'Até onde o Brasil vai?',          'choice',
      JSON.stringify(['Fase de Grupos', '16 avos', 'Oitavas', 'Quartas', 'Semifinal', 'Vice', 'Campeão']), 15],
  ];
  for (const [qkey, question, qtype, options, points] of QUESTIONS) {
    await run(
      `INSERT INTO bonus_questions (competition_id, qkey, question, qtype, options, points, lock_at)
       VALUES (1, $1, $2, $3, $4, $5, $6) ON CONFLICT (qkey) DO NOTHING`,
      [qkey, question, qtype, options, points, LOCK]
    );
  }
}

// Garante schema + jogos carregados. Memoizado (roda uma vez por processo).
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) readyPromise = (async () => {
    await exec(SCHEMA);
    const row = await get('SELECT COUNT(*)::int AS c FROM matches');
    if (!row || row.c === 0) {
      await seedMatches();
    }
    await migrateToGroups();
  })().catch((e) => { readyPromise = null; throw e; });
  return readyPromise;
}

async function seedMatches() {
  const matches = require('./matches-2026.json');
  const stageOf = (round) => round <= 3 ? 'grupos'
    : round === 4 ? 'r32' : round === 5 ? 'oitavas'
    : round === 6 ? 'quartas' : round === 7 ? 'semis' : 'final';
  for (const [num, round, date, home, away, group, location] of matches) {
    await run(
      `INSERT INTO matches (id, stage, round, group_name, date_utc, location, home_team, away_team)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [num, stageOf(round), round, group, date.replace(' ', 'T'), location, home, away]
    );
  }
  console.log(`[seed] ${matches.length} jogos garantidos no banco.`);
}

// ------------------------------------------------- settings helpers
async function getSetting(key, fallback = null) {
  const row = await get('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

// Segredo para assinar tokens: usa env JWT_SECRET ou gera e guarda no banco.
async function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  let s = await getSetting('jwt_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    await run(
      `INSERT INTO settings (key, value) VALUES ('jwt_secret', $1)
       ON CONFLICT (key) DO NOTHING`, [s]
    );
    s = await getSetting('jwt_secret'); // garante o valor vencedor em corrida de cold starts
  }
  return s;
}

module.exports = { query, get, all, run, exec, ensureReady, seedMatches, getSetting, setSetting, getSecret, genInviteCode };
