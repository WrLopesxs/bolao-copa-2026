/**
 * api/billing.js
 * Premium por grupo via Stripe Checkout (R$ 29,90, pagamento único).
 *
 * Sem SDK: a API da Stripe é REST puro (form-encoded), chamada com fetch.
 * Fluxo: botão no painel do grupo → POST /groups/:gid/checkout → redirect
 * para a página da Stripe → volta em /#/grupo/sucesso/{SESSION_ID}.
 * A ativação acontece por DOIS caminhos (o que chegar primeiro):
 *   1. webhook checkout.session.completed (produção, com assinatura verificada)
 *   2. confirmação pós-redirect (GET na sessão — funciona até no localhost)
 */
const crypto = require('node:crypto');
const express = require('express');
const { get, run } = require('../database/data');
const { requireAuth } = require('../backend/auth');
const { h, rateLimit } = require('./helpers');

const router = express.Router();

const PREMIUM_PRICE_CENTS = 2990; // R$ 29,90
const STRIPE_API = 'https://api.stripe.com/v1';

const stripeKey = () => process.env.STRIPE_SECRET_KEY || '';

/** Achata um objeto para o formato form-encoded da Stripe (a[b][0][c]=x). */
function flatten(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') flatten(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

/** Chamada à API da Stripe; devolve o JSON ou lança erro legível. */
async function stripe(method, path, body = null) {
  const res = await fetch(STRIPE_API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + stripeKey(),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? flatten(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[stripe]', data.error?.message || res.status);
    throw new Error(data.error?.message || 'Falha na comunicação com o pagamento.');
  }
  return data;
}

/** Marca o grupo como premium e registra o pagamento (idempotente por sessão). */
async function activatePremium(session) {
  const groupId = Number(session.metadata?.group_id);
  if (!groupId || session.payment_status !== 'paid') return false;
  const dup = await get('SELECT id FROM payments WHERE session_id = $1', [session.id]);
  if (dup) return true; // já processado (webhook + confirmação podem chegar os dois)
  await run('INSERT INTO payments (group_id, user_id, session_id, amount) VALUES ($1,$2,$3,$4)',
    [groupId, Number(session.metadata?.user_id) || null, session.id, session.amount_total || PREMIUM_PRICE_CENTS]);
  await run(`UPDATE groups SET plan = 'premium', max_members = NULL WHERE id = $1`, [groupId]);
  console.log(`[premium] Grupo #${groupId} ativado (sessão ${session.id}).`);
  return true;
}

// ------------------------------------------------ criar checkout
// (a checagem de membro/admin é feita aqui mesmo para não depender do groups.js)
router.post('/groups/:gid/checkout', requireAuth, rateLimit(10, 10 * 60_000), h(async (req, res) => {
  if (!stripeKey()) return res.status(503).json({ error: 'Pagamentos ainda não configurados. Tente mais tarde.' });
  const gid = Number(req.params.gid);
  const group = await get('SELECT * FROM groups WHERE id = $1', [gid]);
  if (!group) return res.status(404).json({ error: 'Grupo não encontrado.' });
  const member = await get('SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2', [gid, req.user.id]);
  if (!member || (member.role !== 'owner' && member.role !== 'admin'))
    return res.status(403).json({ error: 'Apenas administradores do grupo podem contratar o premium.' });
  if (group.plan === 'premium') return res.status(400).json({ error: 'Este grupo já é premium! 🎉' });

  const origin = req.headers.origin || `http://${req.headers.host}`;
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: String(gid),
    customer_email: req.user.email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'brl',
        unit_amount: PREMIUM_PRICE_CENTS,
        product_data: {
          name: `palpitei Premium — ${group.name}`,
          description: 'Participantes ilimitados, logo, exportação e estatísticas até o fim da competição.',
        },
      },
    }],
    metadata: { group_id: String(gid), user_id: String(req.user.id) },
    success_url: `${origin}/#/grupo/sucesso/{CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/#/grupo`,
  });
  res.json({ url: session.url });
}));

// ------------------------------------------------ confirmação pós-redirect
// O navegador volta do checkout com o id da sessão; consultamos a Stripe
// direto (fonte da verdade) — funciona no localhost, onde webhook não chega.
router.post('/groups/:gid/checkout/confirm', requireAuth, rateLimit(20, 10 * 60_000), h(async (req, res) => {
  const sessionId = String(req.body?.session_id || '');
  if (!/^cs_[a-zA-Z0-9_]+$/.test(sessionId)) return res.status(400).json({ error: 'Sessão inválida.' });
  const session = await stripe('GET', `/checkout/sessions/${sessionId}`);
  if (Number(session.metadata?.group_id) !== Number(req.params.gid))
    return res.status(400).json({ error: 'Sessão não pertence a este grupo.' });
  if (session.payment_status !== 'paid')
    return res.status(402).json({ error: 'Pagamento ainda não confirmado. Se você pagou, aguarde alguns segundos e recarregue.' });
  await activatePremium(session);
  res.json({ ok: true });
}));

// ------------------------------------------------ webhook da Stripe
/** Verifica a assinatura do webhook (HMAC SHA-256 do "t.payload"). */
function validSignature(rawBody, header, secret) {
  try {
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
    const expected = crypto.createHmac('sha256', secret)
      .update(`${parts.t}.${rawBody}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || ''));
  } catch { return false; }
}

router.post('/stripe/webhook', h(async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (secret) {
    const ok = req.rawBody && validSignature(req.rawBody.toString('utf8'), req.headers['stripe-signature'] || '', secret);
    if (!ok) return res.status(400).json({ error: 'assinatura inválida' });
  } else if (process.env.VERCEL) {
    // em produção sem segredo configurado, não aceita webhook às cegas
    return res.status(503).json({ error: 'webhook não configurado' });
  }
  const event = req.body || {};
  if (event.type === 'checkout.session.completed') {
    await activatePremium(event.data?.object || {});
  }
  res.json({ received: true });
}));

module.exports = router;
