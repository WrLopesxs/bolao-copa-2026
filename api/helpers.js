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

function publicMatch(m) {
  const t = (name) => teams[name] || null;
  const iso = m.date_utc instanceof Date ? m.date_utc.toISOString() : m.date_utc;
  return {
    ...m, date_utc: iso, locked: isLocked(m),
    home_pt: t(m.home_team)?.pt || m.home_team,
    away_pt: t(m.away_team)?.pt || m.away_team,
    home_flag: t(m.home_team)?.code || null,
    away_flag: t(m.away_team)?.code || null,
  };
}

function validScore(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}

const lc = (s) => String(s || '').trim().toLowerCase();

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

module.exports = { h, isLocked, publicMatch, validScore, lc, rateLimit, LOCK_BEFORE_MS };
