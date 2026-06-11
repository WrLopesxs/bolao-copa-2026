/**
 * database/seed.js
 * Carrega/garante os 104 jogos da Copa 2026 no banco.
 * Uso: npm run seed   (normalmente não é preciso: o servidor faz isso sozinho)
 */
const { ensureReady, seedMatches } = require('./data');

(async () => {
  await ensureReady();
  await seedMatches();
  console.log('Seed concluído.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
