/**
 * backend/auth.js
 * Autenticação: hash de senha (scrypt), tokens de sessão assinados (HMAC)
 * e middlewares async de proteção de rotas. Sem dependências externas.
 */
const crypto = require('node:crypto');
const { get, getSecret } = require('../database/data');

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias

// ------------------------------------------------------------- senhas
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
}

// ------------------------------------------------------------- tokens
const b64url = (buf) => Buffer.from(buf).toString('base64url');
async function sign(payloadB64) {
  const secret = await getSecret();
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}
/** Gera token de sessão: base64url(payload).assinatura */
async function createToken(userId) {
  const payload = b64url(JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${await sign(payload)}`;
}
/** Valida o token e devolve o usuário (ou null). */
async function verifyToken(token) {
  try {
    const [payloadB64, sig] = String(token).split('.');
    if (!payloadB64 || !sig) return null;
    const expected = await sign(payloadB64);
    if (sig.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return await get(
      'SELECT id, name, email, sector, photo, is_admin, created_at FROM users WHERE id = $1',
      [payload.uid]
    );
  } catch {
    return null;
  }
}

// -------------------------------------------------------- middlewares
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  verifyToken(token).then((user) => {
    if (!user) return res.status(401).json({ error: 'Não autenticado. Faça login.' });
    req.user = user;
    next();
  }).catch(next);
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
    next();
  });
}

module.exports = { hashPassword, verifyPassword, createToken, verifyToken, requireAuth, requireAdmin };
