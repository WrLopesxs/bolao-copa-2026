/**
 * backend/scoring.js
 * Regras de pontuação do bolão e recálculo (versão async/Postgres).
 *
 *   Placar exato ........................... 10 pontos
 *   Resultado correto (vitória/empate) .....  5 pontos
 *   Gols de um dos times corretos ..........  2 pontos (por time)
 */
const { get, all, run } = require('../database/data');

const POINTS = { EXACT: 10, OUTCOME: 5, TEAM_GOALS: 2 };

/** Calcula os pontos de um palpite contra o resultado real. */
function calcPoints(realHome, realAway, predHome, predAway) {
  if (realHome === null || realAway === null) return null;
  if (realHome === predHome && realAway === predAway) return POINTS.EXACT;
  let pts = 0;
  if (Math.sign(realHome - realAway) === Math.sign(predHome - predAway)) pts += POINTS.OUTCOME;
  if (realHome === predHome) pts += POINTS.TEAM_GOALS;
  if (realAway === predAway) pts += POINTS.TEAM_GOALS;
  return pts;
}

/** Pontua todos os palpites de um jogo encerrado. Devolve [{user_id, points, delta}]. */
async function scoreMatch(matchId) {
  const match = await get('SELECT * FROM matches WHERE id = $1', [matchId]);
  if (!match || match.status !== 'finished' ||
      match.home_score === null || match.away_score === null) return [];

  const preds = await all('SELECT * FROM predictions WHERE match_id = $1', [matchId]);
  const results = [];
  for (const p of preds) {
    const pts = calcPoints(match.home_score, match.away_score, p.home_pred, p.away_pred);
    const delta = pts - (p.points || 0);
    await run('UPDATE predictions SET points = $1 WHERE id = $2', [pts, p.id]);
    await run(
      `INSERT INTO score_history (user_id, match_id, points) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, match_id) DO UPDATE SET points = excluded.points`,
      [p.user_id, matchId, pts]
    );
    results.push({ user_id: p.user_id, points: pts, delta });
  }
  return results;
}

/** Recalcula tudo (usado quando o admin corrige um resultado). */
async function rescoreAll() {
  const finished = await all(`SELECT id FROM matches WHERE status = 'finished'`);
  for (const m of finished) await scoreMatch(m.id);
  await run(`UPDATE predictions SET points = NULL
             WHERE match_id IN (SELECT id FROM matches WHERE status <> 'finished')`);
  await run(`DELETE FROM score_history
             WHERE match_id IN (SELECT id FROM matches WHERE status <> 'finished')`);
}

const VALID_STAGES = ['grupos', 'r32', 'oitavas', 'quartas', 'semis', 'final'];

/** Ranking geral (ou por fase). */
async function getRanking(stage = null) {
  if (stage && !VALID_STAGES.includes(stage)) stage = null;
  const predSql = stage
    ? `SELECT p.* FROM predictions p JOIN matches m ON m.id = p.match_id WHERE m.stage = $1`
    : `SELECT * FROM predictions`;
  const rows = await all(`
    SELECT u.id, u.name, u.photo, u.sector,
           COALESCE(SUM(p.points),0)::int                          AS total_points,
           COALESCE(SUM(CASE WHEN p.points = 10 THEN 1 END),0)::int AS exact_hits,
           COUNT(p.id)::int                                        AS total_predictions,
           COALESCE(SUM(CASE WHEN p.points > 0 THEN 1 END),0)::int  AS scoring_hits
    FROM users u
    LEFT JOIN (${predSql}) p ON p.user_id = u.id
    GROUP BY u.id
    ORDER BY total_points DESC, exact_hits DESC, scoring_hits DESC, u.name ASC
  `, stage ? [stage] : []);
  return rows.map((r, i) => ({ ...r, position: i + 1 }));
}

module.exports = { POINTS, calcPoints, scoreMatch, rescoreAll, getRanking };
