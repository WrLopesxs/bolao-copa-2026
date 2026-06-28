/**
 * api/helpers.js
 * Utilitários compartilhados entre routes.js e groups.js.
 */
const teams = require('../database/teams.json');

const LOCK_BEFORE_MS = 60 * 60 * 1000; // palpites travam 1h antes do jogo

/** Envolve handlers async para capturar erros. */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function isLocked(match, now = Date.now()) {
  if (match.status !== 'scheduled') return true;
  if (match.lock_mode === 'open') return false;
  if (match.lock_mode === 'locked') return true;
  return now >= new Date(match.date_utc).getTime() - LOCK_BEFORE_MS;
}

/**
 * Nome amigável do time. Se for um time real (teams.json), devolve o nome em PT.
 * Senão, traduz os placeholders de mata-mata da ESPN e os nossos códigos
 * ("2J", "3ABCDF") para um rótulo claro em português ("2º do Grupo J").
 */
function prettyTeam(name) {
  if (teams[name]) return teams[name].pt;
  const s = String(name || '').trim();
  const ORD = { '1': '1º', '2': '2º', '3': '3º', '4': '4º', first: '1º', second: '2º', third: '3º', fourth: '4º' };
  let m;
  // ESPN: "Group J 2nd Place"
  if ((m = s.match(/^Group ([A-L]) (\d)(?:st|nd|rd|th)? Place$/i))) return `${ORD[m[2]]} do Grupo ${m[1].toUpperCase()}`;
  // ESPN: "Third Place Group E/F/G/I/J" / "2nd Place Group ..."
  if ((m = s.match(/^(\d{1,2}|First|Second|Third|Fourth)(?:st|nd|rd|th)? Place Group ([A-L/]+)$/i)))
    return `${ORD[m[1].toLowerCase()] || ORD[m[1]] || m[1]} colocado (Grupos ${m[2].toUpperCase()})`;
  // ESPN: "Winner Match 73" / "Runner-Up Match 73"
  if ((m = s.match(/^Winner(?:s)? Match (\d+)$/i))) return `Vencedor do jogo ${m[1]}`;
  if ((m = s.match(/^(?:Runner-?Up|Loser) Match (\d+)$/i))) return `Perdedor do jogo ${m[1]}`;
  // nossos códigos: "2J" (posição+grupo) e "3ABCDF" (melhor 3º entre grupos)
  if ((m = s.match(/^([1-4])([A-L])$/))) return `${ORD[m[1]]} do Grupo ${m[2]}`;
  if ((m = s.match(/^([1-4])([A-L]{2,})$/))) return `${ORD[m[1]]} colocado (${m[2].split('').join('/')})`;
  if (/^a definir$/i.test(s)) return 'A definir';
  return s;
}

function publicMatch(m) {
  const t = (name) => teams[name] || null;
  const iso = m.date_utc instanceof Date ? m.date_utc.toISOString() : m.date_utc;
  return {
    ...m, date_utc: iso, locked: isLocked(m),
    home_pt: prettyTeam(m.home_team),
    away_pt: prettyTeam(m.away_team),
    home_flag: t(m.home_team)?.code || null,
    away_flag: t(m.away_team)?.code || null,
  };
}

function validScore(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}

const lc = (s) => String(s || '').trim().toLowerCase();

/** Normaliza texto para comparação tolerante (minúsculo, sem acento). */
const normTxt = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rate limiting simples em memória, por IP+rota. Em serverless cada instância
 * tem seu próprio contador — não é perfeito, mas barra força-bruta básica.
 */
const buckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    if (buckets.size > 5000) buckets.clear(); // evita crescer sem limite
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '?').split(',')[0].trim();
    const key = `${ip}:${req.method}:${req.path}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    if (++b.n > max) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco e tente de novo.' });
    next();
  };
}

module.exports = { h, isLocked, publicMatch, validScore, lc, normTxt, rateLimit, LOCK_BEFORE_MS };
