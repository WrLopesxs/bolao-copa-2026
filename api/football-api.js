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
// Fonte gratuita de placar (API pública da ESPN): sem chave e sem cota.
// Cobre os jogos do dia — perfeita para o placar ao vivo.
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 15 * 60_000); // 15 min (sem jogo rolando)
// Durante um jogo a sync acelera para o placar ao vivo não atrasar.
// Atenção à cota grátis da API-Football (100 req/dia): 3 min cobre bem 1-3 jogos/dia.
const LIVE_SYNC_INTERVAL_MS = Number(process.env.LIVE_SYNC_INTERVAL_MS || 3 * 60_000); // 3 min
// Tempo máximo que um jogo pode ficar "ao vivo": nem o mata-mata (prorrogação +
// pênaltis) passa de ~2h45. Passado isso, o jogo terminou — mesmo que a fonte
// (ESPN/API-Football) tenha parado de listá-lo e não o virou para "encerrado".
const STALE_LIVE_HOURS = Number(process.env.STALE_LIVE_HOURS || 4);

const ALIASES = {
  'south korea': 'korea republic', 'iran': 'ir iran', 'turkey': 'turkiye',
  'ivory coast': 'cote divoire', 'dr congo': 'congo dr', 'czech republic': 'czechia',
  'cape verde islands': 'cabo verde', 'cape verde': 'cabo verde', 'holland': 'netherlands',
  // nomes da ESPN diferentes dos nossos (já normalizados, sem "and"/pontuação)
  'united states': 'usa', 'usmnt': 'usa',
  'republic of ireland': 'ireland', 'uae': 'united arab emirates',
};
function normalize(name) {
  // minúsculo, sem acento; pontuação/hífen viram espaço ("Bosnia-Herzegovina");
  // a palavra "and" é ignorada (aplicado aos DOIS lados, ESPN e banco)
  let n = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
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

/** Sincroniza pelas duas fontes. Devolve true se algo mudou. */
async function syncResults() {
  let changed = await syncFromApiFootball();
  if (await syncFromESPN()) changed = true;
  // failsafe: encerra jogos que ficaram presos em "ao vivo" muito além do fim
  // (a fonte parou de listá-los ou o nome não casou, e nunca os virou)
  if (await finalizeStaleLive()) changed = true;
  // failsafe: pontua jogos encerrados cujos palpites ficaram sem pontos
  // (ex.: a virada para "encerrado" aconteceu numa sync que falhou no meio)
  if (await scoreUnscored()) changed = true;
  return changed;
}

/** Vassoura: jogo ainda "ao vivo" muito depois do início é forçado a encerrar.
 *  Independe da fonte voltar a listar o evento — resolve o jogo "preso ao vivo".
 *  Se já houver placar, pontua; sem placar, ao menos sai do "ao vivo". */
async function finalizeStaleLive() {
  const rows = await all(
    `SELECT id, home_score, away_score FROM matches
      WHERE status = 'live'
        AND date_utc < now() - make_interval(hours => $1::int)`,
    [STALE_LIVE_HOURS]);
  for (const m of rows) {
    console.log(`[ESPN] Failsafe: encerrando jogo #${m.id} preso em "ao vivo".`);
    await run(`UPDATE matches SET status = 'finished' WHERE id = $1`, [m.id]);
    if (m.home_score !== null && m.away_score !== null) await scoreMatch(m.id);
  }
  return rows.length > 0;
}

/** Vassoura: qualquer jogo encerrado com palpite sem pontos é (re)pontuado. */
async function scoreUnscored() {
  const rows = await all(`
    SELECT DISTINCT m.id FROM matches m
      JOIN predictions p ON p.match_id = m.id
     WHERE m.status = 'finished'
       AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL
       AND p.points IS NULL`);
  for (const r of rows) {
    console.log(`[pontuação] Failsafe pontuando o jogo #${r.id}`);
    await scoreMatch(r.id);
  }
  return rows.length > 0;
}

/** Placar ao vivo via ESPN (grátis). Atualiza só jogos em andamento/encerrados. */
async function syncFromESPN() {
  // O scoreboard padrão da ESPN só lista os jogos "de hoje" (no fuso dos EUA):
  // um jogo de madrugada UTC fica agrupado no dia ANTERIOR, e jogos de ontem
  // somem da lista — deixando partidas presas em "ao vivo". Por isso buscamos
  // POR DATA (hoje + dias de jogos pendentes), sempre incluindo o dia anterior.
  const pending = await all(`
    SELECT DISTINCT (date_utc AT TIME ZONE 'UTC')::date AS day FROM matches
     WHERE status = 'live'
        OR (status = 'scheduled' AND date_utc <= now() AND date_utc > now() - interval '12 hours')`);
  const days = new Set();
  const addDay = (d) => {
    const iso = (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
    const t = new Date(iso + 'T00:00:00Z').getTime();
    days.add(iso.replace(/-/g, ''));
    days.add(new Date(t - 86_400_000).toISOString().slice(0, 10).replace(/-/g, ''));
  };
  pending.forEach((r) => addDay(r.day));
  addDay(new Date());

  const events = [];
  for (const day of days) {
    try {
      const res = await fetch(`${ESPN_URL}?dates=${day}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      events.push(...((await res.json()).events || []));
    } catch (err) {
      console.error(`[ESPN] Falha ao buscar ${day}:`, err.message);
    }
  }

  const locals = await all('SELECT * FROM matches');
  let changed = false;
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    const hc = comp?.competitors?.find((c) => c.homeAway === 'home');
    const ac = comp?.competitors?.find((c) => c.homeAway === 'away');
    if (!hc?.team?.name || !ac?.team?.name) continue;

    // monta no formato de fixture da API-Football para reusar o matcher
    // (id -1 evita casar com api_fixture_id nulo de outros jogos)
    const local = findLocalMatch({
      fixture: { id: -1, date: ev.date },
      teams: { home: { name: hc.team.name }, away: { name: ac.team.name } },
    }, locals);
    if (!local) continue;

    const state = ev.status?.type?.state; // pre | in | post
    const status = state === 'post' ? 'finished' : state === 'in' ? 'live' : 'scheduled';
    if (status === 'scheduled') continue; // antes da bola rolar não há o que atualizar
    const hs = hc.score === '' || hc.score == null ? null : Number(hc.score);
    const as = ac.score === '' || ac.score == null ? null : Number(ac.score);
    if (local.status === status && local.home_score === hs && local.away_score === as) continue;

    const isPh = local.home_team === 'A definir' || /^[123][A-L]+$/.test(local.home_team);
    await run(
      `UPDATE matches SET home_score=$1, away_score=$2, status=$3,
         home_team = CASE WHEN $6 THEN $4 ELSE home_team END,
         away_team = CASE WHEN $6 THEN $5 ELSE away_team END
       WHERE id=$7`,
      [hs, as, status, hc.team.name, ac.team.name, isPh, local.id]);
    changed = true;
    if (status === 'finished' && hs !== null && as !== null) await scoreMatch(local.id);
  }

  if (changed) console.log('[ESPN] Placar atualizado em', new Date().toISOString());
  return changed;
}

/** Busca os resultados na API-Football e atualiza o banco. Devolve true se algo mudou. */
async function syncFromApiFootball() {
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

/** Sincroniza só se a última foi há tempo suficiente (evita estouro de cota).
 *  Com jogo rolando (ao vivo, ou agendado que já passou do horário), o
 *  intervalo cai para LIVE_SYNC_INTERVAL_MS e o placar atualiza rápido. */
async function syncIfStale() {
  try {
    // sem chave da API-Football ainda funciona: o placar vem da ESPN (grátis)
    const last = Number(await getSetting('last_sync', '0'));
    const inGameWindow = await get(`
      SELECT 1 AS x FROM matches
       WHERE status = 'live'
          OR (status = 'scheduled' AND date_utc <= now() AND date_utc > now() - interval '3 hours')
       LIMIT 1`);
    const interval = inGameWindow ? LIVE_SYNC_INTERVAL_MS : SYNC_INTERVAL_MS;
    if (Date.now() - last < interval) return false;
    await setSetting('last_sync', Date.now()); // marca antes para evitar disparos simultâneos
    return await syncResults();
  } catch (e) {
    console.error('[API-Football] syncIfStale:', e.message);
    return false;
  }
}

module.exports = { syncResults, syncIfStale, scoreUnscored, finalizeStaleLive };
