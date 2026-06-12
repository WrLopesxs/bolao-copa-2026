/**
 * backend/scoring.js
 * Regras de pontuação do bolão e recálculo (versão async/Postgres).
 *
 *   Placar exato ........................... 10 pontos
 *   Resultado correto (vitória/empate) .....  5 pontos
 *   Gols de um dos times corretos ..........  2 pontos (por time)
 */
const { get, all, run } = require('../database/data');
const teams = require('../database/teams.json');

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

  // Notifica no celular quem acabou de ganhar pontos (delta > 0 evita
  // reenvio quando o rescoreAll repassa jogos já pontuados)
  const gained = results.filter((r) => r.delta > 0);
  if (gained.length) {
    try {
      const { sendPush } = require('../api/push');
      const t = (name) => teams[name]?.pt || name;
      const placar = `${t(match.home_team)} ${match.home_score} x ${match.away_score} ${t(match.away_team)}`;
      for (const g of gained) {
        await sendPush(g.user_id, {
          title: `⚽ Você ganhou +${g.delta} ponto${g.delta > 1 ? 's' : ''}!`,
          body: `${placar} — confira sua posição nos seus grupos.`,
          url: '/#/dashboard',
          tag: 'jogo-' + match.id,
        });
      }
    } catch (e) { console.error('[push] falha ao notificar:', e.message); }
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

/**
 * Ranking geral ou por fase.
 * - group (linha de groups): considera só os membros do grupo — o palpite é
 *   único por usuário; o que muda entre grupos é quem concorre.
 * - Grupo premium: soma os pontos dos palpites bônus (no ranking geral) e,
 *   se o grupo tiver pontuação personalizada, recalcula os pontos dos jogos
 *   na hora com a regra do grupo (a regra padrão fica nos pontos gravados).
 */
async function getRanking(stage = null, group = null) {
  if (stage && !VALID_STAGES.includes(stage)) stage = null;
  const premium = group?.plan === 'premium';
  const custom = premium &&
    (group.points_exact != null || group.points_outcome != null || group.points_goals != null);
  const withBonus = premium && !stage;

  const params = [];
  const p = (v) => { params.push(v); return '$' + params.length; };

  let predSql;
  if (custom) {
    const ex = p(group.points_exact ?? POINTS.EXACT);
    const ou = p(group.points_outcome ?? POINTS.OUTCOME);
    const gl = p(group.points_goals ?? POINTS.TEAM_GOALS);
    predSql = `
      SELECT pr.id, pr.user_id,
        CASE WHEN m.status = 'finished' AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL THEN
          CASE WHEN pr.home_pred = m.home_score AND pr.away_pred = m.away_score THEN ${ex}::int
          ELSE (CASE WHEN SIGN(pr.home_pred - pr.away_pred) = SIGN(m.home_score - m.away_score) THEN ${ou}::int ELSE 0 END)
             + (CASE WHEN pr.home_pred = m.home_score THEN ${gl}::int ELSE 0 END)
             + (CASE WHEN pr.away_pred = m.away_score THEN ${gl}::int ELSE 0 END)
          END
        ELSE NULL END AS points,
        (m.status = 'finished' AND pr.home_pred = m.home_score AND pr.away_pred = m.away_score) AS is_exact
      FROM predictions pr JOIN matches m ON m.id = pr.match_id
      ${stage ? `WHERE m.stage = ${p(stage)}` : ''}`;
  } else if (stage) {
    predSql = `SELECT pr.id, pr.user_id, pr.points, (pr.points = ${POINTS.EXACT}) AS is_exact
                 FROM predictions pr JOIN matches m ON m.id = pr.match_id WHERE m.stage = ${p(stage)}`;
  } else {
    predSql = `SELECT pr.id, pr.user_id, pr.points, (pr.points = ${POINTS.EXACT}) AS is_exact FROM predictions pr`;
  }

  const memberJoin = group ? `JOIN group_members gm ON gm.user_id = u.id AND gm.group_id = ${p(group.id)}` : '';
  const bonusJoin = withBonus
    ? `LEFT JOIN (SELECT user_id, SUM(points)::int AS bpts FROM bonus_answers WHERE points IS NOT NULL GROUP BY user_id) bn ON bn.user_id = u.id`
    : '';

  const rows = await all(`
    SELECT u.id, u.name, u.photo, u.sector,
           ${group ? 'MAX(gm.title) AS title,' : ''}
           COALESCE(SUM(p.points),0)::int ${withBonus ? '+ COALESCE(MAX(bn.bpts),0)' : ''} AS total_points,
           ${withBonus ? 'COALESCE(MAX(bn.bpts),0)::int' : '0'}                AS bonus_points,
           COALESCE(SUM(CASE WHEN p.is_exact THEN 1 END),0)::int               AS exact_hits,
           COUNT(p.id)::int                                                    AS total_predictions,
           COALESCE(SUM(CASE WHEN p.points > 0 THEN 1 END),0)::int             AS scoring_hits
    FROM users u
    ${memberJoin}
    ${bonusJoin}
    LEFT JOIN (${predSql}) p ON p.user_id = u.id
    GROUP BY u.id
    ORDER BY total_points DESC, exact_hits DESC, scoring_hits DESC, u.name ASC
  `, params);
  return rows.map((r, i) => ({ ...r, position: i + 1 }));
}

module.exports = { POINTS, calcPoints, scoreMatch, rescoreAll, getRanking };
