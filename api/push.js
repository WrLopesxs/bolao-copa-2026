/**
 * api/push.js
 * Notificações push (Web Push) — avisa no celular quando o usuário pontua.
 *
 * As chaves VAPID são geradas automaticamente na primeira vez e guardadas
 * na tabela settings (ou vêm das variáveis VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY).
 * Cada aparelho do usuário vira uma linha em push_subs; assinaturas
 * expiradas (HTTP 404/410) são removidas no próprio envio.
 */
const webpush = require('web-push');
const { all, run, getSetting } = require('../database/data');

const SUBJECT = 'mailto:wender.lopesxs@gmail.com';

let vapidPromise = null;
function getVapid() {
  if (!vapidPromise) vapidPromise = (async () => {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
      return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    let raw = await getSetting('vapid_keys');
    if (!raw) {
      const k = webpush.generateVAPIDKeys();
      // DO NOTHING + releitura: se dois cold starts gerarem ao mesmo tempo,
      // todos passam a usar o par que foi gravado primeiro
      await run(`INSERT INTO settings (key, value) VALUES ('vapid_keys', $1) ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify(k)]);
      raw = await getSetting('vapid_keys');
    }
    return JSON.parse(raw);
  })().catch((e) => { vapidPromise = null; throw e; });
  return vapidPromise;
}

/** Registra (ou atualiza) a assinatura de um aparelho. */
async function saveSubscription(userId, sub) {
  await run(
    `INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id,
       p256dh = excluded.p256dh, auth = excluded.auth`,
    [sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth]
  );
}

/** Envia uma notificação para todos os aparelhos de um usuário. */
async function sendPush(userId, payload) {
  const { publicKey, privateKey } = await getVapid();
  const subs = await all('SELECT * FROM push_subs WHERE user_id = $1', [userId]);
  const body = JSON.stringify(payload);
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { vapidDetails: { subject: SUBJECT, publicKey, privateKey }, TTL: 12 * 3600 }
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410)
        await run('DELETE FROM push_subs WHERE endpoint = $1', [s.endpoint]).catch(() => {});
      else console.error('[push]', err.statusCode || '', err.message);
    }
  }
}

module.exports = { getVapid, saveSubscription, sendPush };
