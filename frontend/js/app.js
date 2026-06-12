/* ============================================================
   palpitei — bolão com os amigos (SPA em JS puro)
   ============================================================ */
'use strict';

// ------------------------------------------------------------ estado
const state = {
  token: localStorage.getItem('token') || null,
  user: null,
  groups: [],          // grupos que participo
  group: null,         // grupo ativo
  groupsLoaded: false,
  matches: [],
  filter: 'todos',     // filtro da tela de jogos
  stage: '',           // filtro do ranking por fase
  chart: null,
  ws: null,
};

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');

const STAGES = { grupos: 'Fase de Grupos', r32: '16 avos', oitavas: 'Oitavas', quartas: 'Quartas', semis: 'Semifinais', final: 'Final' };

// ------------------------------------------------------------ API
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { logout(); throw new Error('Sessão expirada'); }
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}
// Chamada escopada no grupo ativo (/api/groups/:id/...)
const gapi = (path, opts) => api(`/groups/${state.group.id}${path}`, opts);

// ------------------------------------------------------------ grupos
/** Carrega meus grupos e restaura (ou escolhe) o grupo ativo. */
async function loadGroups() {
  const d = await api('/groups');
  state.groups = d.groups;
  const savedId = Number(localStorage.getItem('activeGroupId'));
  state.group = state.groups.find((g) => g.id === savedId) || state.groups[0] || null;
  if (state.group) localStorage.setItem('activeGroupId', state.group.id);
  else localStorage.removeItem('activeGroupId');
  state.groupsLoaded = true;
  applyGroupTheme();
  updateGroupChip();
}

function setActiveGroup(g) {
  state.group = g;
  localStorage.setItem('activeGroupId', g.id);
  state.lastPoints = null; // evita toast falso de pontos ao trocar de grupo
  applyGroupTheme();
  updateGroupChip();
}

/** Cores do grupo viram o tema do app (volta ao padrão se o grupo não tiver). */
function applyGroupTheme() {
  const r = document.documentElement.style;
  const g = state.group;
  if (g?.color_primary) {
    r.setProperty('--accent', g.color_primary);
    r.setProperty('--accent-strong', g.color_primary);
    r.setProperty('--accent-soft', g.color_primary + '22');
  } else { r.removeProperty('--accent'); r.removeProperty('--accent-strong'); r.removeProperty('--accent-soft'); }
  if (g?.color_secondary) r.setProperty('--gold', g.color_secondary);
  else r.removeProperty('--gold');
}

function updateGroupChip() {
  const chip = $('#groupChip');
  chip.hidden = !state.group;
  if (state.group) $('#groupChipName').textContent = state.group.name;
  $('#groupBtn').hidden = !state.group; // engrenagem do grupo no header
}
$('#groupBtn').addEventListener('click', () => { location.hash = '#/grupo'; });

// Paleta de cores do grupo (estilo Paint: clica e pronto)
const GROUP_COLORS = ['#117a4b', '#16a34a', '#0d9488', '#1d4ed8', '#0284c7', '#7c3aed', '#db2777', '#cc0000', '#ea580c', '#ca8a04', '#475569', '#111827'];
const ACCENT_COLORS = ['#e0a528', '#f59e0b', '#facc15', '#fb923c', '#f87171', '#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#a3e635', '#94a3b8', '#e5e7eb'];

function colorPicker(name, value, colors) {
  return `<div class="color-grid">
    ${colors.map((c) => `<button type="button" class="swatch ${c.toLowerCase() === String(value).toLowerCase() ? 'sel' : ''}" style="background:${c}" data-c="${c}" title="${c}"></button>`).join('')}
    <input type="hidden" name="${name}" value="${value}">
  </div>`;
}
function bindColorPickers(root = app) {
  root.querySelectorAll('.color-grid').forEach((grid) => {
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.swatch');
      if (!b) return;
      grid.querySelectorAll('.swatch').forEach((s) => s.classList.remove('sel'));
      b.classList.add('sel');
      grid.querySelector('input[type=hidden]').value = b.dataset.c;
    });
  });
}

/** Logo do grupo (imagem) ou bolinha com a inicial. */
function groupLogo(g, size = 34) {
  if (g.logo) return `<img class="avatar" style="border-radius:9px;width:${size}px;height:${size}px" src="${g.logo}" alt="">`;
  return `<span class="avatar" style="border-radius:9px;width:${size}px;height:${size}px;background:${g.color_primary || 'var(--accent-soft)'};color:#fff">${esc((g.name || '?')[0].toUpperCase())}</span>`;
}

/** Modal de troca de grupo (clicando no nome do grupo na barra). */
function groupSwitcherModal() {
  openModal(`
    <div class="modal-head">
      <h3>Meus grupos</h3>
      <button class="close-x" onclick="document.getElementById('modal').hidden=true">✕</button>
    </div>
    <div class="group-list">
      ${state.groups.map((g) => `
        <button class="group-item ${g.id === state.group?.id ? 'active' : ''}" data-gsel="${g.id}">
          ${groupLogo(g)}
          <span class="gi-info"><b>${esc(g.name)}</b>
          <span class="sec">${g.member_count} participante${g.member_count > 1 ? 's' : ''} · ${g.my_role === 'owner' ? 'dono' : g.my_role === 'admin' ? 'admin' : 'membro'}</span></span>
          ${g.id === state.group?.id ? '<span class="tag">atual</span>' : ''}
        </button>`).join('')}
    </div>
    <div class="row-actions" style="margin-top:14px">
      <button class="btn small ghost" id="gsNew">➕ Criar grupo</button>
      <button class="btn small ghost" id="gsJoin">🎟️ Entrar com código</button>
    </div>`);
  document.querySelectorAll('[data-gsel]').forEach((b) => b.addEventListener('click', () => {
    const g = state.groups.find((x) => x.id === Number(b.dataset.gsel));
    if (g && g.id !== state.group?.id) { setActiveGroup(g); toast(`Agora você está no <b>${esc(g.name)}</b>.`); }
    closeModal(); route();
  }));
  $('#gsNew').addEventListener('click', () => { closeModal(); location.hash = '#/novogrupo'; });
  $('#gsJoin').addEventListener('click', () => { closeModal(); location.hash = '#/entrar'; });
}
$('#groupChip').addEventListener('click', groupSwitcherModal);

// ------------------------------------------------------------ utils
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function flag(code, name) {
  if (!code) return `<span class="avatar" style="border-radius:4px;width:30px;height:20px;font-size:.6rem">?</span>`;
  return `<img class="flag" src="https://flagcdn.com/w40/${code}.png" alt="${esc(name)}" loading="lazy">`;
}
function avatar(user) {
  if (user.photo) return `<img class="avatar" src="${user.photo}" alt="">`;
  const ini = (user.name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  return `<span class="avatar">${esc(ini)}</span>`;
}
function fmtDate(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(d) { // '2026-06-12' ou Date -> 12/06
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
}
function medal(pos) { return pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos + 'º'; }

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 5000);
}

function openModal(html) {
  $('#modalCard').innerHTML = html;
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }

// Clique no link da CazéTV não pode abrir o modal de comparação do card
document.addEventListener('click', (e) => {
  if (e.target.closest('.watch-live a')) e.stopPropagation();
}, true);

// Clicar em qualquer foto de avatar (ranking, comparação, online) amplia no lightbox.
document.addEventListener('click', (e) => {
  const img = e.target.closest('img.avatar');
  if (!img) return;
  e.stopPropagation();
  $('#lightbox').querySelector('img').src = img.src;
  $('#lightbox').hidden = false;
});
$('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// ------------------------------------------------------------ ajuda
function openHelp() {
  openModal(`
    <div class="modal-head">
      <h3>❓ Como funciona o palpitei</h3>
      <button class="close-x" onclick="document.getElementById('modal').hidden=true">✕</button>
    </div>
    <div class="help-body">
      <h4>⚽ Dar palpites</h4>
      <p>Na aba <b>Palpites</b>, digite o placar de cada jogo e salve (ou use
      <b>“Salvar todos os palpites”</b> para mandar vários de uma vez). Dá para editar
      quantas vezes quiser até o jogo travar.</p>

      <h4>🔒 Quando trava</h4>
      <p>Os palpites de cada jogo travam <b>1 hora antes</b> de a bola rolar — o card
      mostra um cronômetro (“Trava em…”). Depois disso o palpite fica bloqueado e os
      palpites de todos os participantes ficam visíveis no botão <b>“Ver palpites”</b>.</p>

      <h4>🏆 Pontuação</h4>
      <ul>
        <li><b>10 pontos</b> — placar exato (ex.: cravou 2 a 1)</li>
        <li><b>5 pontos</b> — acertou quem venceu (ou o empate), mas não o placar</li>
        <li><b>2 pontos</b> — acertou os gols de um dos times</li>
      </ul>
      <p class="muted">Alguns grupos personalizam esses valores — confira no ranking do seu grupo.</p>

      <h4>📺 Ao vivo</h4>
      <p>Com o jogo rolando, o card mostra o <b>placar em tempo real</b> ao lado do seu
      palpite e um link para <b>assistir na CazéTV</b>. Quando o jogo acaba, a pontuação
      de todo mundo é calculada automaticamente.</p>

      <h4>📊 Ranking e Início</h4>
      <p>A aba <b>Ranking</b> mostra a classificação do grupo (geral e por fase). A aba
      <b>Início</b> traz seu resumo: posição, pontos, acertos e os próximos jogos.</p>

      <h4>💬 Chat</h4>
      <p>A aba <b>Chat</b> é o mural do grupo — converse, mande emojis e provoque a galera.
      Toque na foto de alguém para ampliar.</p>

      <h4>🔔 Notificações</h4>
      <p>No <b>Perfil</b>, ative as notificações para receber um aviso no celular quando
      você ganhar pontos — mesmo com o site fechado. <i>No iPhone, primeiro adicione o
      site à Tela de Início.</i></p>
    </div>`);
}
$('#helpBtn').addEventListener('click', openHelp);

// ------------------------------------------------------------ tema
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  $('#themeBtn').textContent = t === 'dark' ? '◑' : '◐';
}
$('#themeBtn').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
applyTheme(localStorage.getItem('theme') || 'light');

// ------------------------------------------------------------ tempo real (polling)
// A Vercel não mantém WebSocket aberto, então o tempo real é por sondagem:
// um "heartbeat" registra presença e o dashboard/ranking se atualizam sozinhos.
let rtTimers = [];
function startRealtime() {
  stopRealtime();
  if (!state.token) return;
  beat(); // imediato (registra presença + carrega quem está online)
  setupPush(); // renova a assinatura push se a permissão já foi concedida
  rtTimers.push(setInterval(beat, 20000));   // presença a cada 20s
  rtTimers.push(setInterval(() => {          // auto-refresh a cada 15s
    const r = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];
    // Não recarrega a tela de palpites para não apagar placares sendo digitados
    if (r === 'dashboard' || r === 'ranking') route();
  }, 15000));
}
function stopRealtime() { rtTimers.forEach(clearInterval); rtTimers = []; }
async function beat() {
  if (!state.token) return;
  try { await api('/heartbeat', { method: 'POST' }); } catch {}
  refreshOnline();
}
// mantém o nome antigo usado em alguns pontos do código
const connectWS = startRealtime;

// ------------------------------------------------------------ push no celular
/**
 * Ativa as notificações push neste aparelho.
 * interactive=false: só renova a assinatura se a permissão já foi dada
 * (chamado a cada login); interactive=true: pede a permissão (botão no Perfil).
 */
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isInstalled = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function setupPush(interactive = false) {
  if (!pushSupported) {
    if (interactive) {
      if (isIOS && !isInstalled) pushInstallModal();
      else toast('Este navegador não suporta notificações push.', 'err');
    }
    return;
  }
  try {
    let perm = Notification.permission;
    if (perm === 'default') {
      if (!interactive) return;
      perm = await Notification.requestPermission(); // 1º await: ainda dentro do toque
    }
    if (perm !== 'granted') {
      if (interactive) pushBlockedModal(); // negado: ensina a desbloquear
      return;
    }
    await navigator.serviceWorker.register('/sw.js');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api('/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
    }
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
    if (interactive) toast('🔔 Notificações ativadas neste aparelho!');
  } catch (e) {
    console.warn('[push]', e);
    if (interactive) toast('Não foi possível ativar: ' + esc(e.message), 'err');
  }
}
/** Converte a chave VAPID (base64url) para o formato do pushManager. */
function urlB64(s) {
  const b64 = (s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from([...atob(b64)].map(c => c.charCodeAt(0)));
}

/** Permissão negada anteriormente: o navegador guarda a escolha; ensina a liberar. */
function pushBlockedModal() {
  openModal(`
    <div class="modal-head">
      <h3>🔕 Notificações bloqueadas</h3>
      <button class="close-x" onclick="document.getElementById('modal').hidden=true">✕</button>
    </div>
    <p class="muted" style="margin-bottom:12px">Em algum momento a permissão foi negada e o navegador guardou essa escolha. Para liberar:</p>
    <p style="margin-bottom:10px"><b>Chrome:</b> toque no <b>cadeado 🔒</b> (ou ⚙️) ao lado do endereço do site → <b>Permissões</b> → <b>Notificações</b> → <b>Permitir</b>.</p>
    <p style="margin-bottom:10px"><b>Não achou?</b> Menu <b>⋮</b> → Configurações → Configurações do site → Notificações → procure este site e mude para <b>Permitir</b>.</p>
    <p style="margin-bottom:16px"><b>iPhone</b> (instalado na Tela de Início): Ajustes do iPhone → <b>Notificações</b> → <b>Bolão</b> → Permitir.</p>
    <button class="btn" id="pushRetry">Já liberei — ativar agora</button>`);
  $('#pushRetry').addEventListener('click', () => { closeModal(); setupPush(true); });
}

/** iPhone no Safari sem instalar: a Apple só permite push em site instalado. */
function pushInstallModal() {
  openModal(`
    <div class="modal-head">
      <h3>📲 Falta um passo no iPhone</h3>
      <button class="close-x" onclick="document.getElementById('modal').hidden=true">✕</button>
    </div>
    <p class="muted" style="margin-bottom:12px">No iPhone, notificações só funcionam com o site instalado como app:</p>
    <p style="margin-bottom:8px">1. Toque em <b>Compartilhar</b> (quadrado com seta ↑) na barra do Safari.</p>
    <p style="margin-bottom:8px">2. Escolha <b>Adicionar à Tela de Início</b>.</p>
    <p style="margin-bottom:16px">3. Abra o <b>palpitei</b> pelo novo ícone e ative as notificações no Perfil.</p>
    <button class="btn ghost" onclick="document.getElementById('modal').hidden=true">Entendi</button>`);
}

/** Convite mostrado logo após o login. */
function offerPush() {
  if (!pushSupported) {
    if (isIOS && !isInstalled) pushInstallModal();
    return;
  }
  if (Notification.permission === 'granted') { setupPush(); return; } // só renova a assinatura
  if (Notification.permission === 'denied') { pushBlockedModal(); return; }
  openModal(`
    <div class="modal-head">
      <h3>🔔 Ativar notificações?</h3>
      <button class="close-x" onclick="document.getElementById('modal').hidden=true">✕</button>
    </div>
    <p class="muted" style="margin-bottom:16px">
      Receba um aviso no celular quando você <b>ganhar pontos</b> e quando saírem
      resultados — mesmo com o site fechado.
    </p>
    <div class="row-actions">
      <button class="btn" id="pushYes" style="flex:1">Ativar notificações</button>
      <button class="btn ghost" id="pushNo" style="flex:1">Agora não</button>
    </div>`);
  $('#pushYes').addEventListener('click', () => { closeModal(); setupPush(true); });
  $('#pushNo').addEventListener('click', closeModal);
}

// ------------------------------------------------------------ presença online
/** Atualiza o card "online agora" se ele estiver na tela. */
async function refreshOnline() {
  const box = $('#onlineList');
  if (!box || !state.group) return;
  try {
    const { online } = await gapi('/online');
    $('#onlineCount').textContent = online.length;
    box.innerHTML = online.map(u => `
      <div class="online-item">
        ${avatar(u)}
        <div>${esc(u.name)}${u.sector ? `<span class="sec"> · ${esc(u.sector)}</span>` : ''}</div>
        <span class="dot-on" style="margin-left:auto"></span>
      </div>`).join('') || '<p class="muted">Ninguém conectado agora.</p>';
  } catch { /* silencioso */ }
}

// ------------------------------------------------------------ sessão
function logout() {
  state.token = null; state.user = null;
  state.groups = []; state.group = null; state.groupsLoaded = false;
  localStorage.removeItem('token');
  localStorage.removeItem('activeGroupId');
  stopRealtime();
  applyGroupTheme();
  updateGroupChip();
  location.hash = '#/login';
}
$('#logoutBtn').addEventListener('click', logout);

// ============================================================ TELAS

// ---------- LOGIN / CADASTRO / RECUPERAÇÃO ----------
function viewAuth(mode) {
  $('#topbar').hidden = true;
  const invited = localStorage.getItem('pendingInvite');
  const forms = {
    login: `
      <div class="logo">⚽</div>
      <h1>palpit<b style="color:var(--accent)">ei</b></h1>
      ${invited ? '<p class="sub">🎟️ Você recebeu um convite! Entre ou crie sua conta para participar do grupo.</p>' : '<p class="sub">Entre para dar seus palpites</p>'}
      <form id="f">
        <div class="field"><label>E-mail</label><input name="email" type="email" required autocomplete="email"></div>
        <div class="field"><label>Senha</label><input name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn" type="submit">Entrar</button>
      </form>
      <div class="auth-links">
        <a data-go="cadastro">Criar conta</a> &nbsp;·&nbsp; <a data-go="recuperar">Esqueci a senha</a>
      </div>`,
    cadastro: `
      <div class="logo">⚽</div>
      <h1>Criar conta</h1>
      <p class="sub">${invited ? '🎟️ Crie sua conta para entrar no grupo que te convidou' : 'Crie sua conta, monte seu grupo e convide os amigos'}</p>
      <form id="f">
        <div class="field"><label>Nome completo</label><input name="name" required></div>
        <div class="field"><label>E-mail</label><input name="email" type="email" required></div>
        <div class="field"><label>Time/setor (opcional)</label><input name="sector" placeholder="Ex.: TI, Família, Galera do futebol"></div>
        <div class="field"><label>Senha (mín. 6 caracteres)</label><input name="password" type="password" minlength="6" required></div>
        <button class="btn" type="submit">Cadastrar</button>
      </form>
      <div class="auth-links"><a data-go="login">Já tenho conta</a></div>`,
    recuperar: `
      <div class="logo">⚽</div>
      <h1>Recuperar senha</h1>
      <p class="sub">Gere um código e peça ao administrador do bolão</p>
      <form id="f1">
        <div class="field"><label>E-mail</label><input name="email" type="email" required></div>
        <button class="btn ghost" type="submit">1. Gerar código</button>
      </form>
      <form id="f2" style="margin-top:14px">
        <div class="field"><label>Código recebido</label><input name="code" required></div>
        <div class="field"><label>Nova senha</label><input name="password" type="password" minlength="6" required></div>
        <button class="btn" type="submit">2. Redefinir senha</button>
      </form>
      <div class="auth-links"><a data-go="login">Voltar ao login</a></div>`,
  };
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card">${forms[mode]}</div></div>`;

  app.querySelectorAll('[data-go]').forEach(a =>
    a.addEventListener('click', () => location.hash = '#/' + a.dataset.go));

  if (mode === 'login' || mode === 'cadastro') {
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const data = await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body });
        state.token = data.token; state.user = data.user;
        localStorage.setItem('token', data.token);
        if (data.firstUser) toast('Você é o primeiro usuário e virou <b>administrador da plataforma</b>.', 'gold');
        // convite pendente: entra no grupo automaticamente
        const code = localStorage.getItem('pendingInvite');
        if (code) {
          localStorage.removeItem('pendingInvite');
          try {
            const j = await api(`/invite/${code}/join`, { method: 'POST' });
            toast(`🎉 Você entrou no grupo <b>${esc(j.group.name)}</b>!`, 'gold');
            localStorage.setItem('activeGroupId', j.group.id);
          } catch (err) { toast(esc(err.message), 'err'); }
        }
        await loadGroups();
        offerPush(); // convite para ativar notificações logo após o login
        connectWS();
        location.hash = state.group ? '#/dashboard' : '#/bemvindo';
      } catch (err) { toast(esc(err.message), 'err'); btn.disabled = false; }
    });
  }
  if (mode === 'recuperar') {
    let email = '';
    $('#f1').addEventListener('submit', async (e) => {
      e.preventDefault();
      email = new FormData(e.target).get('email');
      try { const d = await api('/auth/forgot', { method: 'POST', body: { email } }); toast(esc(d.message)); }
      catch (err) { toast(esc(err.message), 'err'); }
    });
    $('#f2').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        const d = await api('/auth/reset', { method: 'POST', body: { email: email || prompt('Confirme seu e-mail:'), ...fd } });
        toast(esc(d.message)); location.hash = '#/login';
      } catch (err) { toast(esc(err.message), 'err'); }
    });
  }
}

// ---------- DASHBOARD ----------
async function viewDashboard() {
  const d = await gapi('/dashboard');
  const me = d.me || { position: '-', total_points: 0, exact_hits: 0, total_predictions: 0 };

  // Notifica ganho de pontos comparando com o valor anterior (substitui o evento WS)
  if (state.lastPoints != null && me.total_points > state.lastPoints) {
    toast(`<b>+${me.total_points - state.lastPoints} pontos!</b> Confira o ranking.`, 'gold');
  }
  state.lastPoints = me.total_points;

  const matchMini = (m) => `
    <div class="match-card" data-compare="${m.id}">
      <div class="match-meta">
        <span>${esc(STAGES[m.stage])}${m.group_name ? ' · Grupo ' + m.group_name : ''} · ${fmtDate(m.date_utc)}</span>
        ${m.status === 'live' ? '<span class="badge live">AO VIVO</span>' : ''}
        ${m.status === 'finished' && m.my_points != null ? `<span class="badge pts">+${m.my_points}</span>` : ''}
      </div>
      <div class="match-row">
        <div class="team home"><span class="name">${esc(m.home_pt)}</span>${flag(m.home_flag, m.home_pt)}</div>
        <div class="score-final">${m.home_score ?? '–'} x ${m.away_score ?? '–'}</div>
        <div class="team">${flag(m.away_flag, m.away_pt)}<span class="name">${esc(m.away_pt)}</span></div>
      </div>
      ${m.status === 'live' ? '<div class="watch-live"><a href="https://www.youtube.com/@CazeTV/live" target="_blank" rel="noopener">📺 Assistir na CazéTV</a></div>' : ''}
    </div>`;

  app.innerHTML = `
    <h2 class="page-title">Olá, ${esc(state.user.name.split(' ')[0])}</h2>
    <p class="page-sub">Sua campanha no <b>${esc(state.group.name)}</b> · <a href="#/grupo" style="color:var(--accent);font-weight:600">ver grupo</a></p>
    <div class="stat-row">
      <div class="stat hero"><div class="num">${me.position && d.total_users ? medal(me.position) : '–'}</div><div class="lbl">Posição</div></div>
      <div class="stat"><div class="num">${me.total_points}</div><div class="lbl">Pontos</div></div>
      <div class="stat"><div class="num">${me.exact_hits}</div><div class="lbl">Placares exatos</div></div>
    </div>

    ${d.premium && (d.round_champion || d.bonus) ? `
    <div class="grid cols-2" style="margin-bottom:14px">
      ${d.round_champion ? `
      <div class="card">
        <h3>🏆 Campeão da rodada · ${fmtDay(d.round_champion.day)}</h3>
        <div class="online-item">${avatar(d.round_champion)}
          <div><b>${esc(d.round_champion.name)}</b><span class="sec"> · ${d.round_champion.points} pts no dia</span></div>
        </div>
      </div>` : ''}
      ${d.bonus ? `
      <div class="card">
        <h3>🎯 Palpites Bônus</h3>
        <p class="muted" style="margin-bottom:10px">Campeão, artilheiro e mais, valendo pontos extras.
          Você respondeu <b>${d.bonus.answered}/${d.bonus.total}</b>${Date.now() < new Date(d.bonus.lock_at).getTime() ? ` · trava em ${fmtDate(d.bonus.lock_at)}` : ' · travado'}.</p>
        <a class="btn ghost" href="#/bonus">${d.bonus.answered < d.bonus.total ? 'Responder agora' : 'Ver meus palpites bônus'}</a>
      </div>` : ''}
    </div>` : ''}
    ${!d.premium ? `
    <div class="card premium-card" style="margin-bottom:14px">
      <p class="muted" style="font-size:.84rem">🎯 Palpites Bônus, 📊 Raio-X, 🏆 Campeão da Rodada e mais —
        <a href="#/grupo" style="color:var(--accent);font-weight:700">conheça o premium ⭐</a></p>
    </div>` : ''}

    ${d.live.length ? `<div class="card"><h3><span class="dot-live"></span> Ao vivo agora</h3><div class="match-list">${d.live.map(matchMini).join('')}</div></div><br>` : ''}

    <div class="grid cols-2">
      <div class="card">
        <h3>Próximos jogos</h3>
        <div class="match-list">${d.upcoming.map(matchMini).join('') || '<p class="muted">Nenhum jogo agendado.</p>'}</div>
        <br><a class="btn ghost" href="#/jogos">Dar palpites</a>
      </div>
      <div class="card">
        <h3>Top 10 do grupo</h3>
        <div class="table-wrap"><table class="rank">
          <tr><th></th><th>Nome</th><th>Pts</th><th>Exatos</th></tr>
          ${d.top10.map(r => `
            <tr class="${r.id === state.user.id ? 'me' : ''}">
              <td class="pos">${medal(r.position)}</td>
              <td><div class="user-cell">${avatar(r)}<div>${esc(r.name)}<span class="sec">${esc(r.sector || '')}</span></div></div></td>
              <td><b>${r.total_points}</b></td><td>${r.exact_hits}</td>
            </tr>`).join('')}
        </table></div>
        <br><a class="btn ghost" href="#/ranking">Ranking completo</a>
      </div>
    </div>
    <br>
    <div class="grid cols-2">
      <div class="card">
        <h3>Minha evolução</h3>
        ${d.evolution.length ? '<div class="chart-box"><canvas id="evo"></canvas></div>' : '<p class="muted">Seus pontos aparecerão aqui quando os jogos terminarem.</p>'}
      </div>
      <div class="card">
        <h3><span class="dot-on"></span> Online agora · <span id="onlineCount">0</span></h3>
        <div class="online-list" id="onlineList"><p class="muted">Carregando…</p></div>
        <br>
        <h3>Últimos resultados</h3>
        <div class="match-list">${d.recent.map(matchMini).join('') || '<p class="muted">Nenhum jogo encerrado ainda.</p>'}</div>
      </div>
    </div>`;
  refreshOnline();

  // Gráfico de evolução (Chart.js) — se a lib não carregar, o resto da tela sobrevive
  if (d.evolution.length && typeof Chart !== 'undefined') try {
    state.chart?.destroy();
    state.chart = new Chart($('#evo'), {
      type: 'line',
      data: {
        // começa do zero para a linha mostrar a subida desde o início
        labels: ['Início', ...d.evolution.map(e => new Date(e.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }))],
        datasets: [{
          label: 'Pontos acumulados', data: [0, ...d.evolution.map(e => e.total)],
          borderColor: '#117a4b', backgroundColor: 'rgba(17,122,75,.12)',
          fill: true, tension: .3, pointBackgroundColor: '#117a4b', pointRadius: 3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }, // só pontos inteiros
      },
    });
  } catch (e) { console.warn('[chart]', e); }
  bindCompare();
}

// ---------- JOGOS & PALPITES ----------
// Jogos cujo palpite já confirmado o usuário reabriu para editar.
const editingMatches = new Set();
// Mesma regra do backend: trava 1h antes do jogo (respeitando lock_mode).
const LOCK_BEFORE_MS = 60 * 60 * 1000;
function isLockedNow(m, now = Date.now()) {
  if (m.locked) return true;
  if (m.status !== 'scheduled') return true;
  if (m.lock_mode === 'open') return false;
  return now >= new Date(m.date_utc).getTime() - LOCK_BEFORE_MS;
}
let lockWatch = null;

// Tempo restante até o bloqueio: "3d 4h" quando falta muito, "2h 15min" / "40min" quando está perto.
function fmtCountdown(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), mm = min % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}min`;
  return `${mm}min`;
}
// Atualiza só o texto dos cronômetros (não re-renderiza, para não apagar placares digitados)
function updateCountdowns() {
  const t = Date.now();
  document.querySelectorAll('[data-lock-at]').forEach(el => {
    el.textContent = 'Trava em ' + fmtCountdown(Number(el.dataset.lockAt) - t);
  });
}

// Jogo rolando agora (ao vivo, ou agendado que passou do horário há menos de 3h)
function isOngoing(m, now = Date.now()) {
  if (m.status === 'live') return true;
  const start = new Date(m.date_utc).getTime();
  return m.status === 'scheduled' && now >= start && now < start + 3 * 3600_000;
}

// Busca o placar mais novo e atualiza os cards na tela, sem re-renderizar
// (não apaga palpites sendo digitados). Re-renderiza só se um status mudou.
async function refreshLiveScores() {
  try {
    const { matches } = await api('/matches');
    const statusChanged = matches.some(m =>
      state.matches.find(x => x.id === m.id)?.status !== m.status);
    state.matches = matches;
    matches.forEach(m => {
      if (m.status === 'scheduled' && !isOngoing(m)) return;
      const el = document.querySelector(`.match-card[data-id="${m.id}"] .score-final`);
      if (el) el.textContent = `${m.home_score ?? '–'} x ${m.away_score ?? '–'}`;
    });
    const typing = document.activeElement && document.activeElement.matches('.score-box input');
    if (statusChanged && !typing) viewJogos();
  } catch {} // rede falhou: tenta no próximo ciclo
}

async function viewJogos() {
  const { matches } = await api('/matches');
  state.matches = matches;
  const f = state.filter;
  const now = Date.now();

  const list = matches.filter(m => {
    if (f === 'futuros') return m.status === 'scheduled';
    if (f === 'aovivo') return m.status === 'live';
    if (f === 'encerrados') return m.status === 'finished';
    if (f === 'abertos') return !m.locked && m.status === 'scheduled';
    if (Object.keys(STAGES).includes(f)) return m.stage === f;
    return true;
  });

  const chips = [
    ['todos', 'Todos'], ['abertos', 'Abertos'], ['futuros', 'Futuros'],
    ['aovivo', 'Ao vivo'], ['encerrados', 'Encerrados'],
    ...Object.entries(STAGES),
  ];

  const matchCard = (m) => {
    const pred = m.my_prediction;
    const locked = isLockedNow(m, now);
    const open = !locked && m.status === 'scheduled';
    // Palpite já confirmado fica bloqueado até o usuário clicar em "Editar"
    const confirmed = open && pred && !editingMatches.has(m.id);
    const editable = open && !confirmed;
    // Jogo que já começou (mesmo que o sync ainda não tenha marcado "ao vivo")
    const started = m.status !== 'scheduled' || now >= new Date(m.date_utc).getTime();
    const emAndamento = m.status === 'live' || (m.status === 'scheduled' && started && locked);
    return `
    <div class="match-card" data-id="${m.id}">
      <div class="match-meta">
        <span>${esc(STAGES[m.stage])}${m.group_name ? ' · Grupo ' + m.group_name : ''} · ${fmtDate(m.date_utc)} · ${esc(m.location)}</span>
        <span class="meta-badges">
        ${m.status === 'live' ? '<span class="badge live">AO VIVO</span>'
          : m.status === 'finished' ? '<span class="badge fin">Encerrado</span>'
          : emAndamento ? '<span class="badge live">EM ANDAMENTO</span>'
          : locked ? '<span class="badge fin">Bloqueado</span>'
          : `${m.lock_mode !== 'open'
              ? `<span class="badge timer" data-lock-at="${new Date(m.date_utc).getTime() - LOCK_BEFORE_MS}"></span>` : ''}<span class="badge sched">Aberto</span>`}
        ${pred?.points != null ? `<span class="badge pts">+${pred.points} pts</span>` : ''}
        </span>
      </div>
      <div class="match-row">
        <div class="team home"><span class="name">${esc(m.home_pt)}</span>${flag(m.home_flag, m.home_pt)}</div>
        ${started
          ? `<div class="score-final">${m.home_score ?? '–'} x ${m.away_score ?? '–'}</div>`
          : editable
            ? `<div class="score-box">
                 <input type="number" min="0" max="99" inputmode="numeric" data-h value="${pred ? pred.home : ''}" placeholder="–">
                 <span class="x">x</span>
                 <input type="number" min="0" max="99" inputmode="numeric" data-a value="${pred ? pred.away : ''}" placeholder="–">
               </div>`
            : confirmed
              ? `<div class="score-box">
                   <input type="number" data-h value="${pred.home}" disabled>
                   <span class="x">x</span>
                   <input type="number" data-a value="${pred.away}" disabled>
                 </div>`
              : `<div class="score-final">${pred ? pred.home + ' x ' + pred.away : '–'}</div>`}
        <div class="team">${flag(m.away_flag, m.away_pt)}<span class="name">${esc(m.away_pt)}</span></div>
      </div>
      ${started && pred ? `<div class="my-pred">Meu palpite: <b>${pred.home} x ${pred.away}</b></div>` : ''}
      ${emAndamento ? `<div class="watch-live"><a href="https://www.youtube.com/@CazeTV/live" target="_blank" rel="noopener">📺 Assistir na CazéTV</a></div>` : ''}
      <div class="match-actions">
        ${editable ? `<button class="btn small" data-save="${m.id}">Salvar palpite</button>` : ''}
        ${confirmed ? `<button class="btn small ghost" data-edit="${m.id}">Editar</button>` : ''}
        ${locked ? `<button class="btn small ghost" data-compare="${m.id}">Ver palpites</button>` : ''}
      </div>
    </div>`;
  };

  // Quantos jogos do filtro atual estão com os placares liberados para digitar
  const editableCount = list.filter(m =>
    !isLockedNow(m, now) && m.status === 'scheduled' &&
    (!m.my_prediction || editingMatches.has(m.id))).length;

  app.innerHTML = `
    <h2 class="page-title">Jogos e palpites</h2>
    <p class="page-sub">Os palpites travam automaticamente 1 hora antes de cada jogo</p>
    <div class="filters">${chips.map(([k, v]) =>
      `<button class="chip ${f === k ? 'active' : ''}" data-f="${k}">${v}</button>`).join('')}</div>
    <div class="match-list">${list.map(matchCard).join('') || '<p class="muted">Nenhum jogo neste filtro.</p>'}</div>
    ${editableCount > 1 ? `<div class="save-all-bar"><button class="btn" id="save-all">Salvar todos os palpites</button></div>` : ''}`;

  app.querySelectorAll('[data-f]').forEach(b =>
    b.addEventListener('click', () => { state.filter = b.dataset.f; viewJogos(); }));

  app.querySelectorAll('[data-save]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const card = b.closest('.match-card');
    const home = card.querySelector('[data-h]').value;
    const away = card.querySelector('[data-a]').value;
    if (home === '' || away === '') return toast('Preencha os dois placares.', 'err');
    b.disabled = true;
    try {
      const id = Number(b.dataset.save);
      await api('/predictions', { method: 'POST', body: { match_id: id, home, away } });
      editingMatches.delete(id);
      toast('Palpite salvo!');
      viewJogos(); // re-renderiza: o palpite confirmado aparece bloqueado com botão "Editar"
      return;
    } catch (err) { toast(esc(err.message), 'err'); }
    b.disabled = false;
  }));

  // Salva de uma vez todos os palpites preenchidos na tela
  const saveAllBtn = app.querySelector('#save-all');
  saveAllBtn?.addEventListener('click', async () => {
    const toSave = [];
    app.querySelectorAll('.match-card').forEach(card => {
      if (!card.querySelector('[data-save]')) return; // só cards em edição
      const home = card.querySelector('[data-h]').value;
      const away = card.querySelector('[data-a]').value;
      if (home !== '' && away !== '') toSave.push({ id: Number(card.dataset.id), home, away });
    });
    if (!toSave.length) return toast('Preencha os placares dos jogos que quer salvar.', 'err');
    saveAllBtn.disabled = true;
    saveAllBtn.textContent = 'Salvando…';
    let ok = 0; const errors = [];
    for (const p of toSave) {
      try {
        await api('/predictions', { method: 'POST', body: { match_id: p.id, home: p.home, away: p.away } });
        editingMatches.delete(p.id);
        ok++;
      } catch (err) { errors.push(err.message); }
    }
    if (errors.length) toast(`${ok} palpite(s) salvos, ${errors.length} com erro: ${esc(errors[0])}`, 'err');
    else toast(`${ok} palpites salvos!`);
    viewJogos();
  });

  // Reabre o palpite confirmado para edição
  app.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    editingMatches.add(Number(b.dataset.edit));
    viewJogos();
  }));

  // Evita que clicar nos inputs abra a comparação
  app.querySelectorAll('.score-box input').forEach(i => i.addEventListener('click', e => e.stopPropagation()));
  bindCompare();
  updateCountdowns();

  // Quando o horário de bloqueio chega, re-renderiza para o botão "Editar" sumir
  // sem precisar recarregar a página (não roda se o usuário estiver digitando um placar).
  // Também mantém os cronômetros "Trava em ..." atualizados.
  if (lockWatch) clearInterval(lockWatch);
  lockWatch = setInterval(() => {
    const r = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];
    if (r !== 'jogos') { clearInterval(lockWatch); lockWatch = null; return; }
    updateCountdowns();
    if (state.matches.some(m => isOngoing(m))) refreshLiveScores(); // placar ao vivo
    const justLocked = state.matches.some(m => !m.locked && isLockedNow(m));
    const typing = document.activeElement && document.activeElement.matches('.score-box input');
    if (justLocked && !typing) viewJogos();
  }, 30000);
}

// ---------- COMPARAÇÃO DE PALPITES ----------
function bindCompare() {
  document.querySelectorAll('[data-compare]').forEach(el =>
    el.addEventListener('click', () => showCompare(Number(el.dataset.compare))));
}
async function showCompare(matchId) {
  try {
    const d = await gapi(`/matches/${matchId}/predictions`);
    const m = d.match;
    openModal(`
      <div class="modal-head">
        <h3>${esc(m.home_pt)} x ${esc(m.away_pt)}</h3>
        <button class="close-x" onclick="document.getElementById('modal').hidden=true">✕</button>
      </div>
      <p class="muted" style="margin-bottom:10px">
        ${fmtDate(m.date_utc)} · ${esc(m.location)}<br>
        Resultado: <b>${m.home_score ?? '–'} x ${m.away_score ?? '–'}</b>
        ${m.status === 'live' ? ' <span class="badge live">AO VIVO</span>' : ''}
      </p>
      ${!d.locked ? '<p class="muted">Os palpites dos colegas ficam visíveis depois do bloqueio (1h antes do jogo).</p>' : `
      <div class="table-wrap"><table class="rank">
        <tr><th>Participante</th><th>Palpite</th><th>Pts</th></tr>
        ${d.predictions.map(p => `
          <tr class="${p.user_id === state.user.id ? 'me' : ''}">
            <td><div class="user-cell">${avatar(p)}<div>${esc(p.name)}
              ${state.group?.plan === 'premium' && p.updated_at ? `<span class="sec" title="auditoria: quando o palpite foi salvo">🕐 salvo ${fmtDate(p.updated_at)}</span>` : ''}
            </div></div></td>
            <td><b>${p.home_pred} x ${p.away_pred}</b></td>
            <td>${p.points ?? '–'}</td>
          </tr>`).join('') || '<tr><td colspan="3" class="muted">Ninguém palpitou neste jogo.</td></tr>'}
      </table></div>`}
    `);
  } catch (err) { toast(esc(err.message), 'err'); }
}

// ---------- RANKING ----------
async function viewRanking() {
  const stage = state.stage;
  const d = await gapi('/ranking' + (stage ? '?stage=' + stage : ''));
  app.innerHTML = `
    <h2 class="page-title">Ranking ${stage ? '— ' + STAGES[stage] : 'geral'}</h2>
    <p class="page-sub">${esc(state.group.name)} · atualizado em tempo real conforme os jogos terminam</p>
    <div class="filters">
      <button class="chip ${!stage ? 'active' : ''}" data-s="">Geral</button>
      ${Object.entries(STAGES).map(([k, v]) =>
        `<button class="chip ${stage === k ? 'active' : ''}" data-s="${k}">${v}</button>`).join('')}
      <a class="chip" href="#/raio" style="text-decoration:none">📊 Raio-X${state.group.plan !== 'premium' ? ' ⭐' : ''}</a>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="rank">
        <tr><th>Pos</th><th>Participante</th><th>Pontos</th><th>Exatos</th><th>Palpites</th></tr>
        ${d.ranking.map(r => `
          <tr class="${r.id === state.user.id ? 'me' : ''}">
            <td class="pos">${medal(r.position)}</td>
            <td><div class="user-cell">${avatar(r)}<div>${esc(r.name)}${r.title ? ` <span class="tag gold">${esc(r.title)}</span>` : ''}<span class="sec">${esc(r.sector || '')}</span></div></div></td>
            <td><b>${r.total_points}</b>${r.bonus_points > 0 ? ` <span class="sec" title="pontos dos palpites bônus">🎯+${r.bonus_points}</span>` : ''}</td>
            <td>${r.exact_hits}</td>
            <td>${r.total_predictions}</td>
          </tr>`).join('')}
      </table></div>
      <br>
      <p class="muted">Pontuação: placar exato = <b>${d.points_table.EXACT}</b> ·
        resultado correto = <b>${d.points_table.OUTCOME}</b> ·
        gols de um time corretos = <b>${d.points_table.TEAM_GOALS}</b> (por time)</p>
    </div>`;
  app.querySelectorAll('[data-s]').forEach(b =>
    b.addEventListener('click', () => { state.stage = b.dataset.s; viewRanking(); }));
}

// ---------- PERFIL ----------
async function viewPerfil() {
  const { user } = await api('/auth/me');
  state.user = user;
  app.innerHTML = `
    <h2 class="page-title">Meu perfil</h2>
    <p class="page-sub">Seus dados no bolão</p>
    <div class="grid cols-2">
      <div class="card">
        <div style="text-align:center;margin-bottom:14px">
          <span id="avatarBox" style="zoom:2.2">${avatar(user)}</span>
        </div>
        <form id="pf">
          <div class="field"><label>Nome completo</label><input name="name" value="${esc(user.name)}" required></div>
          <div class="field"><label>Setor</label><input name="sector" value="${esc(user.sector || '')}"></div>
          <div class="field"><label>Foto (opcional, máx. 350KB)</label><input type="file" id="photoInput" accept="image/*"></div>
          <div class="field"><label>Nova senha (deixe vazio para manter)</label><input name="password" type="password" minlength="6" placeholder="••••••"></div>
          <button class="btn" type="submit">Salvar alterações</button>
        </form>
      </div>
      <div class="card">
        <h3>Informações</h3>
        <p><b>E-mail:</b> ${esc(user.email)}</p>
        <p><b>Cadastro:</b> ${new Date(user.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR')}</p>
        <p><b>Tipo:</b> ${user.is_admin ? 'Administrador da plataforma' : 'Participante'}</p>
        <p><b>Meus grupos:</b> ${state.groups.length}</p>
        <br>
        <h3>🔔 Notificações</h3>
        <p class="muted" style="margin-bottom:10px">
          Receba um aviso no celular quando você ganhar pontos — mesmo com o site fechado.
          <br><b>No iPhone:</b> primeiro toque em Compartilhar → <b>Adicionar à Tela de Início</b> e abra por lá.
        </p>
        <button class="btn ghost" id="pushBtn">Ativar notificações neste aparelho</button>
      </div>
    </div>`;

  $('#pushBtn').addEventListener('click', () => setupPush(true));

  let photoData = null;
  $('#photoInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Redimensiona a imagem no navegador para caber no limite
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const s = Math.min(1, 200 / Math.max(img.width, img.height));
      c.width = img.width * s; c.height = img.height * s;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      photoData = c.toDataURL('image/jpeg', .8);
      $('#avatarBox').innerHTML = `<img class="avatar" src="${photoData}">`;
    };
    img.src = URL.createObjectURL(file);
  });

  $('#pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const body = { name: fd.name, sector: fd.sector };
    if (fd.password) body.password = fd.password;
    if (photoData) body.photo = photoData;
    try {
      const d = await api('/auth/profile', { method: 'PUT', body });
      state.user = d.user;
      toast('Perfil atualizado!');
    } catch (err) { toast(esc(err.message), 'err'); }
  });
}

// ---------- ADMIN ----------
async function viewAdmin(tab = 'jogos') {
  if (!state.user?.is_admin) { location.hash = '#/dashboard'; return; }

  const tabs = [['jogos', 'Jogos'], ['usuarios', 'Usuários'], ['bonus', 'Bônus 🎯'], ['config', 'Configurações']];
  let inner = '';

  if (tab === 'bonus') {
    const d = await api('/admin/bonus');
    const answersFor = (qid) => d.answers.filter((a) => a.question_id === qid);
    const tPt = (en) => d.teams.find((t) => t.en === en)?.pt || en;
    inner = d.questions.map((q) => {
      const ans = answersFor(q.id);
      const total = ans.reduce((s, a) => s + a.n, 0);
      const field = q.qtype === 'team'
        ? `<select name="correct_answer"><option value="">— sem gabarito —</option>
             ${d.teams.map((t) => `<option value="${esc(t.en)}" ${q.correct_answer === t.en ? 'selected' : ''}>${esc(t.pt)}</option>`).join('')}</select>`
        : q.qtype === 'choice'
          ? `<select name="correct_answer"><option value="">— sem gabarito —</option>
               ${q.options.map((o) => `<option value="${esc(o)}" ${q.correct_answer === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
          : `<input name="correct_answer" maxlength="60" value="${esc(q.correct_answer || '')}" placeholder="Ex.: Haaland">`;
      return `
      <div class="card" style="margin-bottom:14px">
        <h3>${esc(q.question)} <span class="badge pts">+${q.points} pts</span></h3>
        <p class="muted" style="margin-bottom:8px">Trava em ${fmtDate(q.lock_at)} · <b>${total}</b> resposta(s)
          ${ans.length ? '· mais votadas: ' + ans.slice(0, 4).map((a) => `<b>${esc(q.qtype === 'team' ? tPt(a.answer) : a.answer)}</b> (${a.n})`).join(', ') : ''}</p>
        <form data-bq="${q.id}" class="inline-form">
          <div class="field"><label>Resposta certa</label>${field}</div>
          <button class="btn small" type="submit">Salvar gabarito</button>
        </form>
      </div>`;
    }).join('');
  }

  if (tab === 'usuarios') {
    const { users } = await api('/admin/users');
    inner = `
      <div class="card">
        <h3>Adicionar usuário</h3>
        <form id="addUser" class="inline-form">
          <div class="field"><label>Nome</label><input name="name" required></div>
          <div class="field"><label>E-mail</label><input name="email" type="email" required></div>
          <div class="field"><label>Setor</label><input name="sector"></div>
          <div class="field"><label>Senha</label><input name="password" required></div>
          <button class="btn small" type="submit">Adicionar</button>
        </form>
      </div><br>
      <div class="card" style="border-color:var(--gold)">
        <h3>🛠️ Corrigir pontuação <span class="tag">temporário</span></h3>
        <p class="muted" style="margin-bottom:10px">
          Mostra os palpites de um participante com os pontos de cada um. Use “Remover”
          para apagar um palpite que entrou errado — o total cai exatamente os pontos
          daquele jogo e o ranking se ajusta.
        </p>
        <div class="inline-form">
          <div class="field"><label>Participante</label>
            <select id="fixUser">
              <option value="">Selecione…</option>
              ${users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
            </select></div>
          <button class="btn small" id="fixLoad" type="button">Ver palpites e pontos</button>
        </div>
        <div id="fixList" style="margin-top:12px"></div>
      </div><br>
      <div class="card"><div class="table-wrap"><table class="rank">
        <tr><th>Nome</th><th>E-mail</th><th>Setor</th><th>Palpites</th><th>Código recup.</th><th>Ações</th></tr>
        ${users.map(u => `
          <tr>
            <td>${esc(u.name)} ${u.is_admin ? '<span class="tag">admin</span>' : ''}</td>
            <td>${esc(u.email)}</td>
            <td>${esc(u.sector || '')}</td>
            <td>${u.predictions}</td>
            <td>${u.reset_token ? `<b style="color:var(--gold-2)">${u.reset_token}</b>` : '–'}</td>
            <td><div class="row-actions">
              <button class="btn small ghost" data-toggleadmin="${u.id}" data-val="${u.is_admin ? 0 : 1}">${u.is_admin ? 'Remover admin' : 'Tornar admin'}</button>
              <button class="btn small danger" data-del="${u.id}">Remover</button>
            </div></td>
          </tr>`).join('')}
      </table></div></div>`;
  }

  if (tab === 'jogos') {
    const { matches } = await api('/matches');
    state.matches = matches; // usado pelo modal de edição
    inner = `
      <div class="card">
        <p class="muted" style="margin-bottom:10px">Clique em um jogo para editar resultado, status, horário e bloqueio de palpites. Use "Encerrado" para pontuar os palpites.</p>
        <div class="table-wrap"><table class="rank">
          <tr><th>#</th><th>Jogo</th><th>Data</th><th>Placar</th><th>Status</th><th>Palpites</th></tr>
          ${matches.map(m => `
            <tr style="cursor:pointer" data-edit="${m.id}">
              <td>${m.id}</td>
              <td>${esc(m.home_pt)} x ${esc(m.away_pt)}</td>
              <td>${fmtDate(m.date_utc)}</td>
              <td><b>${m.home_score ?? '–'} x ${m.away_score ?? '–'}</b></td>
              <td>${m.status === 'finished' ? '✅' : m.status === 'live' ? '🔴' : '📅'}
                  ${m.lock_mode !== 'auto' ? (m.lock_mode === 'open' ? '🔓' : '🔒') : ''}</td>
              <td>${m.locked ? '🔒' : '🔓'}</td>
            </tr>`).join('')}
        </table></div>
      </div>`;
  }

  if (tab === 'config') {
    const s = await api('/admin/settings');
    inner = `
      <div class="grid cols-2">
        <div class="card">
          <h3>API-Football — resultados automáticos</h3>
          <p class="muted" style="margin-bottom:10px">
            Crie uma conta gratuita em <b>dashboard.api-football.com</b>, copie sua chave e cole abaixo.
            O sistema busca os resultados a cada 1 minuto, pontua e atualiza o ranking sozinho.
            ${s.has_key ? '<br><b style="color:var(--accent)">Chave configurada: ' + esc(s.api_football_key) + '</b>' : '<br><b style="color:var(--danger)">Sem chave: lance os resultados manualmente na aba Jogos.</b>'}
          </p>
          <form id="keyForm" class="inline-form">
            <div class="field"><label>Chave da API</label><input name="key" placeholder="cole a chave aqui"></div>
            <button class="btn small" type="submit">Salvar</button>
          </form>
          <br><button class="btn ghost" id="syncNow">Sincronizar agora</button>
        </div>
        <div class="card">
          <h3>Exportar</h3>
          <p class="muted" style="margin-bottom:10px">Baixa o ranking completo em CSV (abre no Excel).</p>
          <button class="btn gold" id="exportBtn">Exportar ranking (Excel)</button>
        </div>
        <div class="card">
          <h3>🔔 Notificações</h3>
          <p class="muted" style="margin-bottom:10px">
            Envie um aviso no celular dos participantes (só chega para quem ativou as
            notificações no Perfil). Deixe em branco para usar a mensagem de teste padrão.
          </p>
          <div class="field"><label>Título</label><input id="ntTitle" placeholder="🔔 Bolão Copa 2026"></div>
          <div class="field"><label>Mensagem</label><input id="ntBody" placeholder="Teste: as notificações estão funcionando!"></div>
          <div class="row-actions">
            <button class="btn small ghost" id="ntTest">Testar (só você)</button>
            <button class="btn small" id="ntAll">Enviar a todos</button>
          </div>
        </div>
      </div>`;
  }

  app.innerHTML = `
    <h2 class="page-title">Painel da plataforma</h2>
    <p class="page-sub">Jogos, resultados e usuários de TODOS os grupos (só você vê isso)</p>
    <div class="admin-tabs">${tabs.map(([k, v]) =>
      `<button class="chip ${tab === k ? 'active' : ''}" data-tab="${k}">${v}</button>`).join('')}</div>
    ${inner}`;

  app.querySelectorAll('[data-tab]').forEach(b =>
    b.addEventListener('click', () => viewAdmin(b.dataset.tab)));

  // --- ações da aba usuários
  $('#addUser')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/admin/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Usuário criado!'); viewAdmin('usuarios');
    } catch (err) { toast(esc(err.message), 'err'); }
  });
  app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remover este usuário e todos os seus palpites?')) return;
    try { await api('/admin/users/' + b.dataset.del, { method: 'DELETE' }); toast('Usuário removido.'); viewAdmin('usuarios'); }
    catch (err) { toast(esc(err.message), 'err'); }
  }));
  app.querySelectorAll('[data-toggleadmin]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api('/admin/users/' + b.dataset.toggleadmin, { method: 'PUT', body: { is_admin: Number(b.dataset.val) } });
      viewAdmin('usuarios');
    } catch (err) { toast(esc(err.message), 'err'); }
  }));

  // --- ferramenta temporária: corrigir pontuação (ver/remover palpites)
  const renderFixList = async (uid) => {
    const box = $('#fixList');
    box.innerHTML = '<p class="muted">Carregando…</p>';
    const { predictions } = await api('/admin/user-predictions/' + uid);
    if (!predictions.length) { box.innerHTML = '<p class="muted">Este participante não tem palpites.</p>'; return; }
    const total = predictions.reduce((s, p) => s + (p.points || 0), 0);
    box.innerHTML = `
      <p style="margin-bottom:8px"><b>Total de pontos: ${total}</b></p>
      <div class="table-wrap"><table class="rank">
        <tr><th>Jogo</th><th>Palpite</th><th>Pontos</th><th></th></tr>
        ${predictions.map(p => `
          <tr>
            <td>${esc(p.label)}</td>
            <td>${p.home_pred} x ${p.away_pred}</td>
            <td><b>${p.points ?? '–'}</b></td>
            <td><button class="btn small danger" data-fixdel="${p.match_id}">Remover</button></td>
          </tr>`).join('')}
      </table></div>`;
    box.querySelectorAll('[data-fixdel]').forEach(btn => btn.addEventListener('click', async () => {
      const p = predictions.find(x => x.match_id === Number(btn.dataset.fixdel));
      if (!confirm(`Remover o palpite de "${p.label}" (${p.home_pred} x ${p.away_pred}, ${p.points ?? 0} pts)?`)) return;
      try {
        await api('/admin/user-prediction', { method: 'DELETE', body: { user_id: Number(uid), match_id: p.match_id } });
        toast('Palpite removido. Pontuação corrigida.');
        renderFixList(uid);
      } catch (err) { toast(esc(err.message), 'err'); }
    }));
  };
  $('#fixLoad')?.addEventListener('click', () => {
    const uid = $('#fixUser').value;
    if (!uid) return toast('Selecione um participante.', 'err');
    renderFixList(uid);
  });

  // --- ações da aba bônus (gabarito)
  app.querySelectorAll('[data-bq]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = await api('/admin/bonus/' + f.dataset.bq, {
        method: 'PUT', body: { correct_answer: new FormData(f).get('correct_answer') },
      });
      toast(`Gabarito salvo! ${d.scored} resposta(s) pontuada(s).`);
    } catch (err) { toast(esc(err.message), 'err'); }
  }));

  // --- ações da aba jogos
  app.querySelectorAll('[data-edit]').forEach(tr =>
    tr.addEventListener('click', () => editMatchModal(Number(tr.dataset.edit))));

  // --- ações da aba config
  $('#keyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/admin/settings', { method: 'PUT', body: { api_football_key: new FormData(e.target).get('key') } });
      toast('Chave salva!'); viewAdmin('config');
    } catch (err) { toast(esc(err.message), 'err'); }
  });
  $('#syncNow')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const d = await api('/admin/sync', { method: 'POST' });
      toast(d.changed ? 'Resultados atualizados!' : 'Nenhuma novidade da API.');
    } catch (err) { toast(esc(err.message), 'err'); }
    e.target.disabled = false;
  });
  const sendNotice = async (btn, everyone) => {
    if (everyone && !confirm('Enviar esta notificação para TODOS os participantes?')) return;
    btn.disabled = true;
    try {
      const d = await api('/admin/push-test', {
        method: 'POST',
        body: { title: $('#ntTitle').value, body: $('#ntBody').value, everyone },
      });
      toast(d.devices
        ? `Notificação enviada para <b>${d.devices}</b> aparelho(s) de ${d.users} usuário(s).`
        : 'Nenhum aparelho inscrito ainda. Ative as notificações no Perfil deste celular primeiro.',
        d.devices ? '' : 'err');
    } catch (err) { toast(esc(err.message), 'err'); }
    btn.disabled = false;
  };
  $('#ntTest')?.addEventListener('click', (e) => sendNotice(e.target, false));
  $('#ntAll')?.addEventListener('click', (e) => sendNotice(e.target, true));

  $('#exportBtn')?.addEventListener('click', async () => {
    // Baixa o CSV autenticado e dispara o download
    const res = await fetch('/api/admin/export', { headers: { Authorization: 'Bearer ' + state.token } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ranking-bolao.csv';
    a.click();
  });
}

/** Modal de edição de jogo (admin) */
function editMatchModal(id) {
  const m = state.matches.find(x => x.id === id);
  if (!m) return;
  openModal(`
    <div class="modal-head">
      <h3>Editar jogo #${m.id}</h3>
      <button class="close-x" onclick="document.getElementById('modal').hidden=true">✕</button>
    </div>
    <form id="em">
      <div class="inline-form" style="margin-bottom:10px">
        <div class="field"><label>Time da casa</label><input name="home_team" value="${esc(m.home_team)}"></div>
        <div class="field"><label>Visitante</label><input name="away_team" value="${esc(m.away_team)}"></div>
      </div>
      <p class="muted" style="margin-bottom:10px">Placar atual: <b>${m.home_score ?? '–'} x ${m.away_score ?? '–'}</b> — o placar vem da sincronização automática e não pode ser editado.</p>
      <div class="inline-form" style="margin-bottom:10px">
        <div class="field"><label>Data/hora (UTC)</label><input name="date_utc" value="${esc(m.date_utc)}"></div>
      </div>
      <div class="inline-form" style="margin-bottom:14px">
        <div class="field"><label>Status</label>
          <select name="status">
            <option value="scheduled" ${m.status === 'scheduled' ? 'selected' : ''}>📅 Agendado</option>
            <option value="live" ${m.status === 'live' ? 'selected' : ''}>🔴 Ao vivo</option>
            <option value="finished" ${m.status === 'finished' ? 'selected' : ''}>✅ Encerrado (pontua!)</option>
          </select>
        </div>
        <div class="field"><label>Palpites</label>
          <select name="lock_mode">
            <option value="auto" ${m.lock_mode === 'auto' ? 'selected' : ''}>Automático (trava 1h antes)</option>
            <option value="open" ${m.lock_mode === 'open' ? 'selected' : ''}>🔓 Forçar liberado</option>
            <option value="locked" ${m.lock_mode === 'locked' ? 'selected' : ''}>🔒 Forçar bloqueado</option>
          </select>
        </div>
      </div>
      <button class="btn" type="submit">Salvar jogo</button>
    </form>`);

  $('#em').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/admin/matches/' + id, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      toast('Jogo atualizado e pontuação recalculada!');
      closeModal(); viewAdmin('jogos');
    } catch (err) { toast(esc(err.message), 'err'); }
  });
}

// ---------- CHAT ----------
let chatPoll = null;
let chatLastId = 0;
const CHAT_EMOJIS = ['⚽', '🥅', '🏆', '🔥', '😂', '😅', '😍', '😎', '🤙', '👏', '👍', '👎', '🙏', '💪', '🎉', '😭', '😡', '🐐', '🍀', '🤝'];

function fmtChatTime(iso) {
  const d = new Date(iso);
  const hoje = d.toDateString() === new Date().toDateString();
  return hoje
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function chatMsgHTML(m) {
  const mine = m.user_id === state.user.id;
  return `
    <div class="chat-msg ${mine ? 'mine' : ''}">
      ${mine ? '' : avatar(m)}
      <div class="bubble">
        ${mine ? '' : `<div class="who">${esc(m.name)}</div>`}
        <div class="txt">${esc(m.text)}</div>
        <div class="when">${fmtChatTime(m.created_at)}</div>
      </div>
    </div>`;
}

async function viewChat() {
  app.innerHTML = `
    <h2 class="page-title">Chat do grupo</h2>
    <p class="page-sub">${esc(state.group.name)} — só os participantes do grupo veem as mensagens</p>
    <div class="card chat-card">
      <div class="chat-list" id="chatList"><p class="muted chat-empty">Carregando…</p></div>
      <div class="chat-emojis" id="chatEmojis">${CHAT_EMOJIS.map(e => `<button type="button">${e}</button>`).join('')}</div>
      <form class="chat-form" id="chatForm">
        <input id="chatInput" maxlength="500" placeholder="Escreva uma mensagem…" autocomplete="off">
        <button class="btn small" type="submit">Enviar</button>
      </form>
    </div>`;

  const list = $('#chatList'), input = $('#chatInput');
  chatLastId = 0;
  let firstLoad = true;

  const load = async () => {
    try {
      const d = await gapi(`/chat${chatLastId ? `?after=${chatLastId}` : ''}`);
      if (firstLoad) list.innerHTML = '';
      if (d.messages.length) {
        list.querySelector('.chat-empty')?.remove();
        // só rola para o fim se o usuário já estiver perto dele (não atrapalha quem lê o histórico)
        const nearBottom = firstLoad || list.scrollHeight - list.scrollTop - list.clientHeight < 90;
        list.insertAdjacentHTML('beforeend', d.messages.map(chatMsgHTML).join(''));
        chatLastId = d.messages[d.messages.length - 1].id;
        if (nearBottom) list.scrollTop = list.scrollHeight;
      } else if (firstLoad) {
        list.innerHTML = '<p class="muted chat-empty">Nenhuma mensagem ainda. Comece a conversa! ⚽</p>';
      }
      firstLoad = false;
    } catch {} // falha de rede no polling: tenta de novo no próximo ciclo
  };
  await load();

  // novas mensagens a cada 5s enquanto a aba Chat estiver aberta
  if (chatPoll) clearInterval(chatPoll);
  chatPoll = setInterval(() => {
    const r = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];
    if (r !== 'chat') { clearInterval(chatPoll); chatPoll = null; return; }
    load();
  }, 5000);

  $('#chatEmojis').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    input.value += b.textContent;
    input.focus();
  });

  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await gapi('/chat', { method: 'POST', body: { text } });
      await load();
    } catch (err) { toast(esc(err.message), 'err'); input.value = text; }
    input.focus();
  });
}

// ---------- BEM-VINDO (sem grupo ainda) ----------
function viewBemvindo() {
  app.innerHTML = `
    <div class="welcome">
      <div class="logo" style="width:56px;height:56px;border-radius:16px;background:var(--accent);color:#fff;font-size:1.6rem;display:flex;align-items:center;justify-content:center;margin:0 auto 14px">⚽</div>
      <h2 class="page-title" style="text-align:center">Bem-vindo ao palpitei, ${esc(state.user.name.split(' ')[0])}!</h2>
      <p class="page-sub" style="text-align:center">Para começar, crie seu grupo de bolão ou entre num grupo existente.</p>
      <div class="grid cols-2" style="max-width:640px;margin:0 auto">
        <a class="card welcome-card" href="#/novogrupo">
          <div class="wc-emoji">➕</div>
          <b>Criar meu grupo</b>
          <p class="muted">Monte o bolão da firma, da família ou dos amigos e convide todo mundo.</p>
        </a>
        <a class="card welcome-card" href="#/entrar">
          <div class="wc-emoji">🎟️</div>
          <b>Entrar com código</b>
          <p class="muted">Recebeu um código ou link de convite? Entre no grupo por aqui.</p>
        </a>
      </div>
      ${state.groups.length ? `
        <br><h3 style="text-align:center;color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.07em">Meus grupos</h3>
        <div class="group-list" style="max-width:640px;margin:10px auto 0">
          ${state.groups.map((g) => `
            <button class="group-item" data-gsel="${g.id}">
              ${groupLogo(g)}
              <span class="gi-info"><b>${esc(g.name)}</b>
              <span class="sec">${g.member_count} participante${g.member_count > 1 ? 's' : ''}</span></span>
            </button>`).join('')}
        </div>` : ''}
    </div>`;
  app.querySelectorAll('[data-gsel]').forEach((b) => b.addEventListener('click', () => {
    setActiveGroup(state.groups.find((x) => x.id === Number(b.dataset.gsel)));
    location.hash = '#/dashboard';
  }));
}

// ---------- CRIAR GRUPO ----------
function viewNovoGrupo() {
  app.innerHTML = `
    <h2 class="page-title">Criar grupo</h2>
    <p class="page-sub">Seu bolão, suas regras: dê um nome e personalize as cores</p>
    <div class="card" style="max-width:520px">
      <form id="ng">
        <div class="field"><label>Nome do grupo</label><input name="name" required minlength="3" maxlength="60" placeholder="Ex.: Bolão Prensas Toyota"></div>
        <div class="field"><label>Descrição (opcional)</label><input name="description" maxlength="300" placeholder="Ex.: bolão oficial do setor 😎"></div>
        <div class="field"><label>Cor principal</label>${colorPicker('color_primary', '#117a4b', GROUP_COLORS)}</div>
        <div class="field"><label>Cor de destaque</label>${colorPicker('color_secondary', '#e0a528', ACCENT_COLORS)}</div>
        <button class="btn" type="submit">Criar grupo</button>
      </form>
    </div>`;
  bindColorPickers();
  $('#ng').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try {
      const d = await api('/groups', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      await loadGroups();
      setActiveGroup(state.groups.find((g) => g.id === d.group.id) || d.group);
      inviteModal(d.group, true);
    } catch (err) { toast(esc(err.message), 'err'); btn.disabled = false; }
  });
}

/** Modal com código e link de convite prontos para compartilhar. */
function inviteModal(group, isNew = false) {
  const link = `${location.origin}/#/invite/${group.invite_code}`;
  openModal(`
    <div class="modal-head">
      <h3>${isNew ? '🎉 Grupo criado!' : '🎟️ Convidar participantes'}</h3>
      <button class="close-x" onclick="document.getElementById('modal').hidden=true">✕</button>
    </div>
    <p class="muted" style="margin-bottom:12px">Compartilhe o link no WhatsApp do pessoal — quem abrir já cai direto no <b>${esc(group.name)}</b>:</p>
    <div class="invite-box"><code>${esc(link)}</code></div>
    <div class="row-actions" style="margin:12px 0">
      <button class="btn small" id="copyLink">📋 Copiar link</button>
      <button class="btn small ghost" id="copyCode">Copiar só o código (${esc(group.invite_code)})</button>
    </div>
    ${isNew ? '<button class="btn gold" id="goDash" style="width:100%">Ir para o meu bolão →</button>' : ''}`);
  const copy = async (text, btn, label) => {
    try { await navigator.clipboard.writeText(text); btn.textContent = '✅ Copiado!'; }
    catch { prompt('Copie manualmente:', text); }
    setTimeout(() => { btn.textContent = label; }, 2000);
  };
  $('#copyLink').addEventListener('click', (e) => copy(link, e.target, '📋 Copiar link'));
  $('#copyCode').addEventListener('click', (e) => copy(group.invite_code, e.target, `Copiar só o código (${group.invite_code})`));
  $('#goDash')?.addEventListener('click', () => { closeModal(); location.hash = '#/dashboard'; route(); });
}

// ---------- ENTRAR COM CÓDIGO ----------
function viewEntrar() {
  app.innerHTML = `
    <h2 class="page-title">Entrar num grupo</h2>
    <p class="page-sub">Digite o código de convite que você recebeu</p>
    <div class="card" style="max-width:440px">
      <form id="jg">
        <div class="field"><label>Código do convite</label>
          <input name="code" required maxlength="10" placeholder="Ex.: ABC123" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700;text-align:center">
        </div>
        <button class="btn" type="submit">Buscar grupo</button>
      </form>
      <div id="jgPreview"></div>
    </div>`;
  $('#jg').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code').toUpperCase().trim();
    try {
      const { group } = await api(`/invite/${code}`);
      $('#jgPreview').innerHTML = `
        <br>
        <div class="group-item" style="cursor:default">
          ${groupLogo(group)}
          <span class="gi-info"><b>${esc(group.name)}</b>
          <span class="sec">${group.member_count} participante${group.member_count > 1 ? 's' : ''}${group.description ? ' · ' + esc(group.description) : ''}</span></span>
        </div>
        <br><button class="btn gold" id="jgConfirm" style="width:100%">Entrar no grupo</button>`;
      $('#jgConfirm').addEventListener('click', async (ev) => {
        ev.target.disabled = true;
        try {
          const j = await api(`/invite/${code}/join`, { method: 'POST' });
          toast(`🎉 Você entrou no <b>${esc(j.group.name)}</b>!`, 'gold');
          await loadGroups();
          setActiveGroup(state.groups.find((g) => g.id === j.group.id));
          location.hash = '#/dashboard';
        } catch (err) { toast(esc(err.message), 'err'); ev.target.disabled = false; }
      });
    } catch (err) { toast(esc(err.message), 'err'); $('#jgPreview').innerHTML = ''; }
  });
}

// ---------- MEU GRUPO (info + gerência) ----------
async function viewGrupo() {
  // Volta do checkout da Stripe: /#/grupo/sucesso/SESSION_ID
  const segs = location.hash.replace('#/', '').split('/');
  if (segs[1] === 'sucesso' && segs[2]) {
    try {
      await gapi('/checkout/confirm', { method: 'POST', body: { session_id: segs[2] } });
      toast('🎉 <b>Grupo premium ativado!</b> Participantes ilimitados liberados.', 'gold');
      await loadGroups();
    } catch (err) { toast(esc(err.message), 'err'); }
    location.hash = '#/grupo';
    return;
  }

  const [{ group }, { members }] = await Promise.all([gapi(''), gapi('/members')]);
  const isAdmin = group.my_role === 'owner' || group.my_role === 'admin';
  const isOwner = group.my_role === 'owner';
  const isPremium = group.plan === 'premium';
  const roleLabel = { owner: '👑 dono', admin: '🛡️ admin', member: 'membro' };

  app.innerHTML = `
    <h2 class="page-title">${esc(group.name)} ${isPremium ? '<span class="badge pts" style="vertical-align:middle">⭐ PREMIUM</span>' : ''}</h2>
    <p class="page-sub">${group.description ? esc(group.description) + ' · ' : ''}${group.member_count} participante${group.member_count > 1 ? 's' : ''}${group.max_members ? ` de ${group.max_members}` : ''} · você é ${roleLabel[group.my_role] || 'membro'}</p>
    <div class="grid cols-2">
      <div>
        ${isAdmin && !isPremium ? `
        <div class="card premium-card">
          <h3>⭐ Vire premium</h3>
          <p class="muted" style="margin-bottom:10px">
            <b>Participantes ilimitados</b> (hoje: ${group.member_count}/${group.max_members || 10}) ·
            🎯 <b>Palpites Bônus</b> (campeão, artilheiro…) · 📊 <b>Raio-X</b> com corrida pelo título e prêmios ·
            🏆 <b>Campeão da Rodada</b> com push automático · 🏷️ títulos de zoeira ·
            🕐 auditoria anti-mamata · pontuação personalizada · logo própria · exportação Excel.
          </p>
          <button class="btn gold" id="goPremium" style="width:100%">⭐ Virar premium — R$ 29,90</button>
          <p class="muted" style="margin-top:8px;font-size:.74rem;text-align:center">Pagamento único e seguro via Stripe · Pix ou cartão</p>
        </div><br>` : ''}
        ${isAdmin ? `
        <div class="card">
          <h3>🎟️ Convite</h3>
          <p class="muted" style="margin-bottom:10px">Compartilhe para chamar mais gente${!isPremium && group.max_members ? ` (${group.member_count}/${group.max_members} no plano gratuito)` : ''}.</p>
          <div class="row-actions">
            <button class="btn small" id="shareBtn">Compartilhar convite</button>
            <button class="btn small ghost" id="newCodeBtn" title="O código antigo deixa de funcionar">Gerar novo código</button>
          </div>
        </div><br>
        <div class="card">
          <h3>🎨 Identidade do grupo</h3>
          <form id="gedit">
            <div class="field"><label>Nome</label><input name="name" value="${esc(group.name)}" required minlength="3" maxlength="60"></div>
            <div class="field"><label>Descrição</label><input name="description" value="${esc(group.description || '')}" maxlength="300"></div>
            ${isPremium
              ? '<div class="field"><label>Logo (opcional, máx. 350KB)</label><input type="file" id="glogoInput" accept="image/*"></div>'
              : '<div class="field"><label>Logo</label><p class="muted" style="font-size:.8rem">⭐ Recurso premium</p></div>'}
            <div class="field"><label>Cor principal</label>${colorPicker('color_primary', group.color_primary || '#117a4b', GROUP_COLORS)}</div>
            <div class="field"><label>Cor de destaque</label>${colorPicker('color_secondary', group.color_secondary || '#e0a528', ACCENT_COLORS)}</div>
            ${isPremium ? `
            <div class="field"><label>Pontuação do grupo (padrão 10 / 5 / 2)</label>
              <div class="inline-form">
                <div class="field"><label class="muted" style="font-weight:500">Placar exato</label><input name="points_exact" type="number" min="0" max="100" value="${group.points_exact ?? 10}"></div>
                <div class="field"><label class="muted" style="font-weight:500">Resultado certo</label><input name="points_outcome" type="number" min="0" max="100" value="${group.points_outcome ?? 5}"></div>
                <div class="field"><label class="muted" style="font-weight:500">Gols de um time</label><input name="points_goals" type="number" min="0" max="100" value="${group.points_goals ?? 2}"></div>
              </div>
              <p class="muted" style="font-size:.72rem">A regra personalizada vale para o ranking do grupo.</p>
            </div>` : ''}
            <button class="btn" type="submit">Salvar</button>
          </form>
        </div><br>
        <div class="card">
          <h3>🔔 Aviso para o grupo</h3>
          <p class="muted" style="margin-bottom:10px">Notificação no celular de quem ativou (ex.: "Palpites encerram às 18h!").</p>
          <div class="field"><label>Título</label><input id="gnTitle" placeholder="🔔 ${esc(group.name)}"></div>
          <div class="field"><label>Mensagem</label><input id="gnBody" placeholder="Aviso do administrador do grupo."></div>
          <button class="btn small" id="gnSend">Enviar aviso</button>
        </div><br>
        <div class="card">
          <h3>📊 Exportar</h3>
          ${isPremium
            ? '<button class="btn gold" id="gExport">Exportar ranking (Excel)</button>'
            : '<p class="muted">⭐ Recurso premium — exporte o ranking completo para o Excel.</p>'}
        </div>` : `
        <div class="card">
          <h3>Sobre o grupo</h3>
          <div style="text-align:center;margin:10px 0">${groupLogo(group, 64)}</div>
          <p class="muted" style="text-align:center">${group.description ? esc(group.description) : 'Sem descrição.'}</p>
          <br>
          <button class="btn danger" id="leaveBtn" style="width:100%">Sair do grupo</button>
        </div>`}
      </div>
      <div class="card">
        <h3>👥 Participantes · ${members.length}</h3>
        <div class="table-wrap"><table class="rank">
          ${members.map((m) => `
            <tr>
              <td><div class="user-cell">${avatar(m)}<div>${esc(m.name)}${m.id === state.user.id ? ' <span class="tag">você</span>' : ''}${m.title ? ` <span class="tag gold">${esc(m.title)}</span>` : ''}<span class="sec">${esc(m.sector || '')}</span></div></div></td>
              <td>${roleLabel[m.role] || ''}</td>
              <td><div class="row-actions">
                ${isPremium && (m.id === state.user.id || isOwner) ? `<button class="btn small ghost" data-gtitle="${m.id}" data-cur="${esc(m.title || '')}" title="${m.id === state.user.id ? 'Definir meu apelido' : 'Moderar apelido'}">🏷️${m.id === state.user.id ? ' meu apelido' : ''}</button>` : ''}
                ${isOwner && m.role !== 'owner' ? `<button class="btn small ghost" data-grole="${m.id}" data-val="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? 'Remover admin' : 'Tornar admin'}</button>` : ''}
                ${isAdmin && m.role !== 'owner' && m.id !== state.user.id ? `<button class="btn small danger" data-gkick="${m.id}">Remover</button>` : ''}
              </div></td>
            </tr>`).join('')}
        </table></div>
        ${isAdmin && !isOwner ? '<br><button class="btn danger" id="leaveBtn" style="width:100%">Sair do grupo</button>' : ''}
      </div>
    </div>`;

  // --- ações de admin do grupo
  bindColorPickers();
  $('#goPremium')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Abrindo pagamento…';
    try {
      const d = await gapi('/checkout', { method: 'POST' });
      location.href = d.url; // página segura de pagamento da Stripe
    } catch (err) {
      toast(esc(err.message), 'err');
      e.target.disabled = false;
      e.target.textContent = '⭐ Virar premium — R$ 29,90';
    }
  });
  $('#shareBtn')?.addEventListener('click', () => inviteModal(group));
  $('#newCodeBtn')?.addEventListener('click', async (e) => {
    if (!confirm('Gerar um código novo? O link/código antigo deixa de funcionar.')) return;
    e.target.disabled = true;
    try {
      const d = await api(`/groups/${group.id}/invite`, { method: 'POST' });
      group.invite_code = d.invite_code;
      toast('Novo código gerado!');
      inviteModal(group);
    } catch (err) { toast(esc(err.message), 'err'); }
    e.target.disabled = false;
  });

  let glogoData = null;
  $('#glogoInput')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const s = Math.min(1, 200 / Math.max(img.width, img.height));
      c.width = img.width * s; c.height = img.height * s;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      glogoData = c.toDataURL('image/jpeg', .8);
      toast('Logo carregada — clique em Salvar.');
    };
    img.src = URL.createObjectURL(file);
  });
  $('#gedit')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    if (glogoData) body.logo = glogoData;
    try {
      await api(`/groups/${group.id}`, { method: 'PUT', body });
      toast('Grupo atualizado!');
      await loadGroups();
      viewGrupo();
    } catch (err) { toast(esc(err.message), 'err'); }
  });

  $('#gnSend')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const d = await gapi('/notify', { method: 'POST', body: { title: $('#gnTitle').value, body: $('#gnBody').value } });
      toast(d.devices ? `Aviso enviado para ${d.devices} aparelho(s).` : 'Ninguém ativou notificações ainda.', d.devices ? '' : 'err');
    } catch (err) { toast(esc(err.message), 'err'); }
    e.target.disabled = false;
  });

  $('#gExport')?.addEventListener('click', async () => {
    const res = await fetch(`/api/groups/${group.id}/export`, { headers: { Authorization: 'Bearer ' + state.token } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ranking-bolao.csv';
    a.click();
  });

  // --- membros
  app.querySelectorAll('[data-gkick]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remover este participante do grupo? (os palpites dele não são apagados)')) return;
    try { await api(`/groups/${group.id}/members/${b.dataset.gkick}`, { method: 'DELETE' }); toast('Participante removido.'); viewGrupo(); }
    catch (err) { toast(esc(err.message), 'err'); }
  }));
  app.querySelectorAll('[data-grole]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/groups/${group.id}/members/${b.dataset.grole}`, { method: 'PUT', body: { role: b.dataset.val } }); viewGrupo(); }
    catch (err) { toast(esc(err.message), 'err'); }
  }));
  // apelido de zoeira (premium): cada um põe o seu ("Mister Zebra 🦓"...);
  // o dono pode moderar o de qualquer membro
  app.querySelectorAll('[data-gtitle]').forEach((b) => b.addEventListener('click', async () => {
    const mine = Number(b.dataset.gtitle) === state.user.id;
    const title = prompt(mine ? 'Seu apelido no grupo (máx. 24 letras — vazio remove):'
      : 'Moderar apelido deste membro (vazio remove):', b.dataset.cur || '');
    if (title === null) return;
    try {
      await api(`/groups/${group.id}/members/${b.dataset.gtitle}`, { method: 'PUT', body: { title } });
      toast(mine ? 'Apelido salvo! 🏷️' : 'Apelido atualizado.');
      viewGrupo();
    } catch (err) { toast(esc(err.message), 'err'); }
  }));
  $('#leaveBtn')?.addEventListener('click', async () => {
    if (!confirm(`Sair do grupo "${group.name}"?`)) return;
    try {
      await api(`/groups/${group.id}/members/${state.user.id}`, { method: 'DELETE' });
      toast('Você saiu do grupo.');
      localStorage.removeItem('activeGroupId');
      await loadGroups();
      location.hash = state.group ? '#/dashboard' : '#/bemvindo';
    } catch (err) { toast(esc(err.message), 'err'); }
  });
}

// ---------- tela de upsell (recurso premium em grupo free) ----------
function premiumUpsellView(featureName) {
  const isAdmin = ['owner', 'admin'].includes(state.group?.my_role);
  app.innerHTML = `
    <div class="welcome" style="max-width:480px;margin:0 auto;text-align:center">
      <div style="font-size:3rem;margin-bottom:8px">⭐</div>
      <h2 class="page-title" style="text-align:center">${esc(featureName)}</h2>
      <p class="page-sub" style="text-align:center">Este recurso é exclusivo de grupos premium —
        junto com participantes ilimitados, logo própria, títulos de zoeira e exportação para Excel.</p>
      <div class="card premium-card">
        ${isAdmin
          ? '<a class="btn gold" href="#/grupo" style="width:100%">⭐ Virar premium — R$ 29,90</a>'
          : `<p class="muted">Peça ao dono do grupo para ativar o premium. 😉</p>`}
      </div>
    </div>`;
}

// ---------- PALPITES BÔNUS (premium) ----------
async function viewBonus() {
  let d;
  try { d = await gapi('/bonus'); }
  catch (err) { premiumUpsellView('🎯 Palpites Bônus'); return; }

  const teamSelect = (q) => `
    <select data-ans="${q.id}">
      <option value="">Escolha a seleção…</option>
      ${d.teams.map((t) => `<option value="${esc(t.en)}" ${q.my_answer === t.en ? 'selected' : ''}>${esc(t.pt)}</option>`).join('')}
    </select>`;
  const choiceSelect = (q) => `
    <select data-ans="${q.id}">
      <option value="">Escolha…</option>
      ${q.options.map((o) => `<option value="${esc(o)}" ${q.my_answer === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select>`;
  const textInput = (q) => `<input data-ans="${q.id}" maxlength="60" placeholder="Ex.: Haaland" value="${esc(q.my_answer || '')}">`;

  app.innerHTML = `
    <h2 class="page-title">🎯 Palpites Bônus</h2>
    <p class="page-sub">Pontos extras que entram no ranking do grupo · respostas valem em todos os seus grupos premium</p>
    <div class="match-list" style="max-width:560px">
      ${d.questions.map((q) => `
      <div class="card">
        <div class="match-meta">
          <span><b style="color:var(--text);font-size:.95rem">${esc(q.question)}</b></span>
          <span class="badge pts">+${q.points} pts</span>
        </div>
        ${q.locked ? `
          <p style="margin-top:8px">Sua resposta: <b>${esc(q.my_answer_pt || '— não respondeu')}</b>
            ${q.my_points != null ? `<span class="badge ${q.my_points > 0 ? 'pts' : 'fin'}">${q.my_points > 0 ? '✅ +' + q.my_points : '0'} pts</span>` : ''}
          </p>
          ${q.correct_answer ? `<p class="muted">Resposta certa: <b>${esc(q.correct_answer)}</b></p>`
            : '<p class="muted">🔒 Travado — aguardando o resultado.</p>'}` : `
          <div class="inline-form" style="margin-top:10px">
            <div class="field">${q.qtype === 'team' ? teamSelect(q) : q.qtype === 'choice' ? choiceSelect(q) : textInput(q)}</div>
            <button class="btn small" data-bsave="${q.id}">Salvar</button>
          </div>
          <p class="muted" style="font-size:.72rem;margin-top:6px">Trava em ${fmtDate(q.lock_at)}</p>`}
      </div>`).join('')}
    </div>`;

  app.querySelectorAll('[data-bsave]').forEach((b) => b.addEventListener('click', async () => {
    const qid = b.dataset.bsave;
    const answer = app.querySelector(`[data-ans="${qid}"]`).value.trim();
    if (!answer) return toast('Escolha ou escreva sua resposta.', 'err');
    b.disabled = true;
    try { await gapi(`/bonus/${qid}`, { method: 'POST', body: { answer } }); toast('Palpite bônus salvo! 🎯'); }
    catch (err) { toast(esc(err.message), 'err'); }
    b.disabled = false;
  }));
}

// ---------- RAIO-X DO GRUPO (premium) ----------
async function viewRaio() {
  let d;
  try { d = await gapi('/stats'); }
  catch (err) { premiumUpsellView('📊 Raio-X do grupo'); return; }
  const s = d.stats;
  if (!s.length) { app.innerHTML = '<div class="card"><p class="muted">Sem dados ainda.</p></div>'; return; }

  // Prêmios sem repetir pessoa: cada troféu vai pro melhor candidato que
  // ainda não ganhou nenhum (em empates, espalha a glória pela galera).
  const used = new Set([s[0].id]); // o líder já leva o primeiro
  const pickBest = (fn, min = 1) => {
    const cand = [...s].sort((a, b) => fn(b) - fn(a))
      .find((x) => fn(x) >= min && !used.has(x.id));
    if (cand) used.add(cand.id);
    return cand || null;
  };
  const awards = [
    ['🥇 Líder', s[0], `${s[0].total} pts`],
    ['🎯 Sniper', pickBest((x) => x.exacts), (x) => `${x.exacts} placares exatos`],
    ['🦓 Rei da Zebra', pickBest((x) => x.zebras), (x) => `${x.zebras} zebra${x.zebras > 1 ? 's' : ''}`],
    ['📈 Melhor rodada', pickBest((x) => x.bestDayPts), (x) => `${x.bestDayPts} pts em ${fmtDay(x.bestDay)}`],
    ['❄️ Pé frio', pickBest((x) => x.zeros, 3), (x) => `${x.zeros} palpites zerados`],
  ];

  app.innerHTML = `
    <h2 class="page-title">📊 Raio-X do grupo</h2>
    <p class="page-sub">${esc(state.group.name)} — estatísticas e prêmios da galera</p>
    <div class="stat-row" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${awards.filter(([, u]) => u).map(([label, u, fmt]) => `
        <div class="stat" style="text-align:center">
          <div style="margin-bottom:4px">${avatar(u)}</div>
          <div class="lbl">${label}</div>
          <div style="font-weight:700;font-size:.85rem">${esc(u.name.split(' ')[0])}</div>
          <div class="lbl" style="text-transform:none">${typeof fmt === 'function' ? fmt(u) : fmt}</div>
        </div>`).join('')}
    </div>
    <div class="card">
      <h3>Corrida pelo título</h3>
      ${s.some((x) => x.evolution.length) ? '<div class="chart-box" style="height:300px"><canvas id="race"></canvas></div>' : '<p class="muted">O gráfico aparece quando os jogos terminarem.</p>'}
    </div>
    <br>
    <div class="card">
      <h3>Desempenho de cada um</h3>
      <div class="table-wrap"><table class="rank">
        <tr><th>Participante</th><th>Pts</th><th>Exatos</th><th>Taxa de acerto</th><th>Melhor dia</th><th>Zebras</th></tr>
        ${s.map((x) => `
          <tr class="${x.id === state.user.id ? 'me' : ''}">
            <td><div class="user-cell">${avatar(x)}<div>${esc(x.name)}${x.title ? ` <span class="tag gold">${esc(x.title)}</span>` : ''}</div></div></td>
            <td><b>${x.total}</b></td><td>${x.exacts}</td><td>${x.accuracy}%</td>
            <td>${x.bestDay ? `${x.bestDayPts} pts (${fmtDay(x.bestDay)})` : '–'}</td><td>${x.zebras}</td>
          </tr>`).join('')}
      </table></div>
    </div>
    ${d.champions.length ? `<br>
    <div class="card">
      <h3>🏆 Campeões das rodadas</h3>
      <div class="online-list">
        ${d.champions.map((c) => `
          <div class="online-item">${avatar(c)}
            <div>${esc(c.name)}<span class="sec"> · ${fmtDay(c.day)} · ${c.points} pts</span></div>
          </div>`).join('')}
      </div>
    </div>` : ''}`;

  // gráfico multi-linhas (top 8 + você)
  if (typeof Chart !== 'undefined' && s.some((x) => x.evolution.length)) try {
    const COLORS = ['#117a4b', '#cc0000', '#1d4ed8', '#ea580c', '#7c3aed', '#ca8a04', '#0d9488', '#db2777'];
    let racers = s.filter((x) => x.evolution.length).slice(0, 8);
    const me = s.find((x) => x.id === state.user.id);
    if (me?.evolution.length && !racers.includes(me)) racers = [...racers.slice(0, 7), me];
    const days = [...new Set(racers.flatMap((x) => x.evolution.map((e) => e.day)))].sort();
    // primeiro nome na legenda; se repetir, acrescenta a inicial do sobrenome
    const firsts = racers.map((x) => x.name.trim().split(/\s+/)[0] || '?');
    const legend = racers.map((x, i) => {
      const dup = firsts.filter((n) => n === firsts[i]).length > 1;
      const sur = x.name.trim().split(/\s+/)[1]?.[0];
      return dup && sur ? `${firsts[i]} ${sur}.` : firsts[i];
    });
    state.chart?.destroy();
    state.chart = new Chart($('#race'), {
      type: 'line',
      data: {
        labels: days.map(fmtDay),
        datasets: racers.map((x, i) => {
          let last = 0;
          const byDay = new Map(x.evolution.map((e) => [e.day, e.total]));
          return {
            label: legend[i],
            data: days.map((day) => (last = byDay.get(day) ?? last)),
            borderColor: COLORS[i % COLORS.length],
            backgroundColor: COLORS[i % COLORS.length],
            tension: .25, pointRadius: 2.5,
          };
        }),
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  } catch (e) { console.warn('[chart]', e); }
}

// ------------------------------------------------------------ roteador
const routes = {
  login: () => viewAuth('login'),
  cadastro: () => viewAuth('cadastro'),
  recuperar: () => viewAuth('recuperar'),
  bemvindo: viewBemvindo,
  novogrupo: viewNovoGrupo,
  entrar: viewEntrar,
  grupo: viewGrupo,
  bonus: viewBonus,
  raio: viewRaio,
  dashboard: viewDashboard,
  jogos: viewJogos,
  ranking: viewRanking,
  chat: viewChat,
  perfil: viewPerfil,
  admin: () => viewAdmin('jogos'),
};

// Telas que só fazem sentido dentro de um grupo ativo
const NEEDS_GROUP = ['dashboard', 'jogos', 'ranking', 'chat', 'grupo', 'bonus', 'raio'];

async function route() {
  const segs = (location.hash.replace('#/', '') || 'dashboard').split('/');
  const name = segs[0] || 'dashboard';
  const isAuthPage = ['login', 'cadastro', 'recuperar'].includes(name);

  // Link de convite (/#/invite/CODIGO): guarda o código e entra após o login
  if (name === 'invite' && segs[1]) {
    localStorage.setItem('pendingInvite', segs[1].toUpperCase().trim());
    if (!state.token) { location.hash = '#/login'; return; }
    const code = localStorage.getItem('pendingInvite');
    localStorage.removeItem('pendingInvite');
    try {
      const j = await api(`/invite/${code}/join`, { method: 'POST' });
      toast(`🎉 Você entrou no grupo <b>${esc(j.group.name)}</b>!`, 'gold');
      localStorage.setItem('activeGroupId', j.group.id);
      state.groupsLoaded = false;
    } catch (err) { toast(esc(err.message), 'err'); }
    location.hash = '#/dashboard';
    return;
  }

  if (!state.token && !isAuthPage) { location.hash = '#/login'; return; }
  if (state.token && isAuthPage) { location.hash = '#/dashboard'; return; }

  // Carrega o usuário na primeira navegação autenticada
  if (state.token && !state.user) {
    try { state.user = (await api('/auth/me')).user; connectWS(); }
    catch { return; } // token inválido -> logout() já redirecionou
  }
  // Carrega os grupos (uma vez por sessão)
  if (state.token && !state.groupsLoaded) {
    try { await loadGroups(); } catch { /* tenta de novo na próxima navegação */ }
  }
  // Sem grupo ainda: tudo leva para o bem-vindo
  if (state.token && !state.group && NEEDS_GROUP.includes(name)) {
    location.hash = '#/bemvindo'; return;
  }

  $('#topbar').hidden = isAuthPage;
  $('#navAdmin').hidden = !state.user?.is_admin;
  updateGroupChip();
  document.querySelectorAll('.nav a').forEach(a =>
    a.classList.toggle('active', a.dataset.route === name));

  const result = (routes[name] || routes.dashboard)();
  if (result?.catch) {
    result.catch(err => {
      app.innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
    });
  }
}

window.addEventListener('hashchange', route);
route();
