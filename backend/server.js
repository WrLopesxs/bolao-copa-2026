/**
 * backend/server.js
 * Servidor LOCAL (no seu PC). Na Vercel este arquivo não é usado —
 * lá entra api/index.js como função serverless.
 *
 *   npm install
 *   npm start      ->  http://localhost:3000
 *
 * Sem DATABASE_URL, o banco roda embutido (PGlite, em database/pgdata),
 * então funciona sem instalar Postgres. Os dados persistem no disco.
 */
const app = require('../api/app');
const { ensureReady } = require('../database/data');
const { syncIfStale } = require('../api/football-api');

const PORT = Number(process.env.PORT || 3000);

// Porta ocupada = o bolão já está rodando em outra janela
const server = app.listen(PORT)
  .on('listening', async () => {
    await ensureReady();
    console.log('==============================================');
    console.log('  ⚽ Bolão da Copa 2026 rodando!');
    console.log(`  Acesse: http://localhost:${PORT}`);
    console.log('  O primeiro usuário cadastrado vira ADMIN.');
    console.log('==============================================');
    // Sincronização periódica de resultados (só local; na Vercel use o Cron)
    setInterval(() => syncIfStale(), 60_000).unref();
  })
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('\n  ⚠️  O bolão JÁ ESTÁ RODANDO na porta ' + PORT + ' (outra janela).');
      console.log('  Não precisa iniciar de novo — use a janela que já está aberta.\n');
      process.exit(0);
    }
    throw err;
  });

module.exports = server;
