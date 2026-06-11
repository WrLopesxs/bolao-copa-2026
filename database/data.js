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

CREATE INDEX IF NOT EXISTS idx_pred_match ON predictions(match_id);
CREATE INDEX IF NOT EXISTS idx_pred_user  ON predictions(user_id);
`;

// Garante schema + jogos carregados. Memoizado (roda uma vez por processo).
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) readyPromise = (async () => {
    await exec(SCHEMA);
    const row = await get('SELECT COUNT(*)::int AS c FROM matches');
    if (!row || row.c === 0) {
      await seedMatches();
    }
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

module.exports = { query, get, all, run, exec, ensureReady, seedMatches, getSetting, setSetting, getSecret };
