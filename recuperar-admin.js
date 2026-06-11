/**
 * recuperar-admin.js
 * Recupera o acesso de administrador sem apagar usuários nem palpites.
 * Funciona no banco LOCAL (PGlite). Para o banco da Vercel, defina
 * DATABASE_URL no terminal antes de rodar.
 *
 * Feche o servidor antes de usar.
 *
 *   node recuperar-admin.js --listar
 *   node recuperar-admin.js seu@email.com NovaSenha123
 */
const { ensureReady, get, run } = require('./database/data');
const { hashPassword } = require('./backend/auth');

(async () => {
  await ensureReady();
  const [, , arg1, arg2] = process.argv;

  if (!arg1 || arg1 === '--ajuda') {
    console.log('Uso:');
    console.log('  node recuperar-admin.js --listar');
    console.log('  node recuperar-admin.js seu@email.com NovaSenha123');
    process.exit(0);
  }

  if (arg1 === '--listar') {
    const users = await require('./database/data').all('SELECT id, name, email, sector, is_admin FROM users ORDER BY id');
    if (!users.length) { console.log('Nenhum usuário cadastrado.'); process.exit(0); }
    console.log('Usuários cadastrados:');
    for (const u of users) console.log(`  #${u.id}  ${u.name}  <${u.email}>  ${u.sector || ''}  ${u.is_admin ? '[ADMIN]' : ''}`);
    process.exit(0);
  }

  const email = String(arg1).trim().toLowerCase();
  const senha = String(arg2 || '').trim();
  if (senha.length < 6) {
    console.log('Informe uma nova senha com pelo menos 6 caracteres.');
    console.log('Exemplo: node recuperar-admin.js seu@email.com NovaSenha123');
    process.exit(1);
  }

  const user = await get('SELECT id, name FROM users WHERE email = $1', [email]);
  if (!user) {
    console.log(`Nenhum usuário com o e-mail "${email}".`);
    console.log('Rode "node recuperar-admin.js --listar" para ver os e-mails.');
    process.exit(1);
  }

  const { hash, salt } = hashPassword(senha);
  await run(`UPDATE users SET password_hash=$1, salt=$2, is_admin=1, reset_token=NULL, reset_expires=NULL WHERE id=$3`,
    [hash, salt, user.id]);

  console.log(`\nPronto! ${user.name} agora é ADMINISTRADOR e a senha foi redefinida.`);
  console.log('Inicie o bolão e faça login com a nova senha.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
