/**
 * api/football-api.js
 * Integração com a API-Football (resultados automáticos) — versão serverless.
 *
 * Em vez de um timer contínuo (que não existe na Vercel), a sincronização
 * é "sob demanda": quando alguém abre o dashboard, se a última sync foi há
 * mais de SYNC_INTERVAL, dispara uma nova. Há também o endpoint /api/cron/sync
 * para o Cron da Vercel chamar periodicamente.
 *
 * Chave: variável de ambiente API_FOOTBALL_KEY ou cadastrada no painel admin.
 */
const { all, run, get, getSetting, setSetting } = require('../database/data');
const { scoreMatch } = require('../backend/scoring');

const API_URL = 'https://v3.football.api-sports.io/fixtures?league=1&season=2026';
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 15 * 60_000); // 15 min

const ALIASES = {
  'south korea': 'korea republic', 'iran': 'ir iran', 'turkey': 'turkiye',
  'ivory coast': 'cote divoire', 'dr congo': 'congo dr', 'czech republic': 'czechia',
  'cape verde islands': 'cabo verde', 'cape verde': 'cabo verde', 'holland': 'netherlands',
};
function normalize(name) {
  let n = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  return ALIASES[n] || n;
}
async function apiKey() {
  return process.env.API_FOOTBALL_KEY || await getSetting('api_football_key', '');
}
function mapStatus(short) {
  if (['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(short)) return 'finished';
  if (['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP'].includes(short)) return 'live';
  return 'scheduled';
}

/** Acha a partida local correspondente a um fixture da API. */
function findLocalMatch(fx, locals) {
  let m = locals.find((x) => x.api_fixture_id === fx.fixture.id);
  if (m) return m;
  const day = fx.fixture.date.slice(0, 10);
  const h = normalize(fx.teams.home.name), a = normalize(fx.teams.away.name);
  const sameDay = locals.filter((c) => new Date(c.date_utc).toISOString().slice(0, 10) >= day &&
                                       new Date(c.date_utc).toISOString().slice(0, 10) <= day);
  const byName = locals.find((c) => {
    const ch = normalize(c.home_team), ca = normalize(c.away_team);
    return (ch === h && ca === a) || (ch === a && ca === h);
  });
  if (byName) return byName;
  // Mata-mata com placeholder ("2A", "A definir"): vincula pelo horário do jogo
  const kickoff = new Date(fx.fixture.date).getTime();
  const ph = locals.filter((c) => !c.api_fixture_id &&
    (c.home_team === 'A definir' || /^[123][A-L]+$/.test(c.home_team)) &&
    Math.abs(new Date(c.date_utc).getTime() - kickoff) < 30 * 60 * 1000);
  return ph.length === 1 ? ph[0] : null;
}

/** Busca os resultados na API e atualiza o banco. Devolve true se algo mudou. */
async function syncResults() {
  const key = await apiKey();
  if (!key) return false;

  let data;
  try {
    const res = await fetch(API_URL, { headers: { 'x-apisports-key': key } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[API-Football] Falha ao buscar:', err.message);
    return false;
  }

  const fixtures = data.response || [];
  const locals = await all('SELECT * FROM matches');
  let changed = false;

  for (const fx of fixtures) {
    const local = findLocalMatch(fx, locals);
    if (!local) continue;
    const status = mapStatus(fx.fixture.status?.short);
    const hs = fx.goals?.home ?? null;
    const as = fx.goals?.away ?? null;
    if (local.status === status && local.home_score === hs &&
        local.away_score === as && local.api_fixture_id === fx.fixture.id) continue;

    const isPh = local.home_team === 'A definir' || /^[123][A-L]+$/.test(local.home_team);
    await run(
      `UPDATE matches SET home_score=$1, away_score=$2, status=$3, api_fixture_id=$4,
         home_team = CASE WHEN $7 THEN $5 ELSE home_team END,
         away_team = CASE WHEN $7 THEN $6 ELSE away_team END
       WHERE id=$8`,
      [hs, as, status, fx.fixture.id, fx.teams.home.name, fx.teams.away.name, isPh, local.id]
    );
    changed = true;
    if (status === 'finished' && hs !== null && as !== null) await scoreMatch(local.id);
  }

  if (changed) console.log('[API-Football] Atualizado em', new Date().toISOString());
  return changed;
}

/** Sincroniza só se a última foi há mais de SYNC_INTERVAL (evita estouro de cota). */
async function syncIfStale() {
  try {
    if (!(await apiKey())) return false;
    const last = Number(await getSetting('last_sync', '0'));
    if (Date.now() - last < SYNC_INTERVAL_MS) return false;
    await setSetting('last_sync', Date.now()); // marca antes para evitar disparos simultâneos
    return await syncResults();
  } catch (e) {
    console.error('[API-Football] syncIfStale:', e.message);
    return false;
  }
}

module.exports = { syncResults, syncIfStale };
