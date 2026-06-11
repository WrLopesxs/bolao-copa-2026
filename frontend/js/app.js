/* ============================================================
   Bolão Copa 2026 — aplicação frontend (SPA em JS puro)
   ============================================================ */
'use strict';

// ------------------------------------------------------------ estado
const state = {
  token: localStorage.getItem('token') || null,
  user: null,
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
    <p style="margin-bottom:16px">3. Abra o <b>Bolão</b> pelo novo ícone e ative as notificações no Perfil.</p>
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
  if (!box) return;
  try {
    const { online } = await api('/online');
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
  localStorage.removeItem('token');
  stopRealtime();
  location.hash = '#/login';
}
$('#logoutBtn').addEventListener('click', logout);

// ============================================================ TELAS

// ---------- LOGIN / CADASTRO / RECUPERAÇÃO ----------
function viewAuth(mode) {
  $('#topbar').hidden = true;
  const forms = {
    login: `
      <div class="logo">⚽</div>
      <h1>Bolão Copa 2026</h1>
      <p class="sub">Entre para dar seus palpites</p>
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
      <p class="sub">O primeiro usuário cadastrado vira administrador</p>
      <form id="f">
        <div class="field"><label>Nome completo</label><input name="name" required></div>
        <div class="field"><label>E-mail</label><input name="email" type="email" required></div>
        <div class="field"><label>Setor</label><input name="sector" placeholder="Ex.: TI, RH, Financeiro"></div>
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
        if (data.firstUser) toast('Você é o primeiro usuário e virou <b>administrador</b>.', 'gold');
        offerPush(); // convite para ativar notificações logo após o login
        connectWS();
        location.hash = '#/dashboard';
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
  const d = await api('/dashboard');
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
    </div>`;

  app.innerHTML = `
    <h2 class="page-title">Olá, ${esc(state.user.name.split(' ')[0])}</h2>
    <p class="page-sub">Acompanhe sua campanha no bolão</p>
    <div class="stat-row">
      <div class="stat hero"><div class="num">${me.position && d.total_users ? medal(me.position) : '–'}</div><div class="lbl">Posição</div></div>
      <div class="stat"><div class="num">${me.total_points}</div><div class="lbl">Pontos</div></div>
      <div class="stat"><div class="num">${me.exact_hits}</div><div class="lbl">Placares exatos</div></div>
    </div>

    ${d.live.length ? `<div class="card"><h3><span class="dot-live"></span> Ao vivo agora</h3><div class="match-list">${d.live.map(matchMini).join('')}</div></div><br>` : ''}

    <div class="grid cols-2">
      <div class="card">
        <h3>Próximos jogos</h3>
        <div class="match-list">${d.upcoming.map(matchMini).join('') || '<p class="muted">Nenhum jogo agendado.</p>'}</div>
        <br><a class="btn ghost" href="#/jogos">Dar palpites</a>
      </div>
      <div class="card">
        <h3>Top 10 do bolão</h3>
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

  // Gráfico de evolução (Chart.js)
  if (d.evolution.length) {
    state.chart?.destroy();
    state.chart = new Chart($('#evo'), {
      type: 'line',
      data: {
        labels: d.evolution.map(e => new Date(e.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })),
        datasets: [{
          label: 'Pontos acumulados', data: d.evolution.map(e => e.total),
          borderColor: '#117a4b', backgroundColor: 'rgba(17,122,75,.12)',
          fill: true, tension: .3, pointBackgroundColor: '#117a4b', pointRadius: 3,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
  }
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
    return `
    <div class="match-card" data-id="${m.id}">
      <div class="match-meta">
        <span>${esc(STAGES[m.stage])}${m.group_name ? ' · Grupo ' + m.group_name : ''} · ${fmtDate(m.date_utc)} · ${esc(m.location)}</span>
        <span class="meta-badges">
        ${m.status === 'live' ? '<span class="badge live">AO VIVO</span>'
          : m.status === 'finished' ? '<span class="badge fin">Encerrado</span>'
          : locked ? '<span class="badge fin">Bloqueado</span>'
          : `${m.lock_mode !== 'open'
              ? `<span class="badge timer" data-lock-at="${new Date(m.date_utc).getTime() - LOCK_BEFORE_MS}"></span>` : ''}<span class="badge sched">Aberto</span>`}
        ${pred?.points != null ? `<span class="badge pts">+${pred.points} pts</span>` : ''}
        </span>
      </div>
      <div class="match-row">
        <div class="team home"><span class="name">${esc(m.home_pt)}</span>${flag(m.home_flag, m.home_pt)}</div>
        ${m.status !== 'scheduled'
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
      ${m.status !== 'scheduled' && pred ? `<div class="my-pred">Meu palpite: <b>${pred.home} x ${pred.away}</b></div>` : ''}
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
    const d = await api(`/matches/${matchId}/predictions`);
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
            <td><div class="user-cell">${avatar(p)}<div>${esc(p.name)}</div></div></td>
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
  const d = await api('/ranking' + (stage ? '?stage=' + stage : ''));
  app.innerHTML = `
    <h2 class="page-title">Ranking ${stage ? '— ' + STAGES[stage] : 'geral'}</h2>
    <p class="page-sub">Atualizado em tempo real conforme os jogos terminam</p>
    <div class="filters">
      <button class="chip ${!stage ? 'active' : ''}" data-s="">Geral</button>
      ${Object.entries(STAGES).map(([k, v]) =>
        `<button class="chip ${stage === k ? 'active' : ''}" data-s="${k}">${v}</button>`).join('')}
    </div>
    <div class="card">
      <div class="table-wrap"><table class="rank">
        <tr><th>Pos</th><th>Participante</th><th>Pontos</th><th>Exatos</th><th>Palpites</th></tr>
        ${d.ranking.map(r => `
          <tr class="${r.id === state.user.id ? 'me' : ''}">
            <td class="pos">${medal(r.position)}</td>
            <td><div class="user-cell">${avatar(r)}<div>${esc(r.name)}<span class="sec">${esc(r.sector || '')}</span></div></div></td>
            <td><b>${r.total_points}</b></td>
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
        <p><b>Tipo:</b> ${user.is_admin ? 'Administrador' : 'Participante'}</p>
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

  const tabs = [['jogos', 'Jogos'], ['usuarios', 'Usuários'], ['config', 'Configurações']];
  let inner = '';

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
    <h2 class="page-title">Painel administrativo</h2>
    <p class="page-sub">Gerencie usuários, jogos e configurações do bolão</p>
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
      <div class="inline-form" style="margin-bottom:10px">
        <div class="field"><label>Gols casa</label><input class="mini-input" name="home_score" type="number" min="0" max="99" value="${m.home_score ?? ''}"></div>
        <div class="field"><label>Gols visitante</label><input class="mini-input" name="away_score" type="number" min="0" max="99" value="${m.away_score ?? ''}"></div>
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
    <h2 class="page-title">Chat do bolão</h2>
    <p class="page-sub">Converse com os participantes — todos veem as mensagens</p>
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
      const d = await api(`/chat${chatLastId ? `?after=${chatLastId}` : ''}`);
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
      await api('/chat', { method: 'POST', body: { text } });
      await load();
    } catch (err) { toast(esc(err.message), 'err'); input.value = text; }
    input.focus();
  });
}

// ------------------------------------------------------------ roteador
const routes = {
  login: () => viewAuth('login'),
  cadastro: () => viewAuth('cadastro'),
  recuperar: () => viewAuth('recuperar'),
  dashboard: viewDashboard,
  jogos: viewJogos,
  ranking: viewRanking,
  chat: viewChat,
  perfil: viewPerfil,
  admin: () => viewAdmin('jogos'),
};

async function route() {
  const name = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];
  const isAuthPage = ['login', 'cadastro', 'recuperar'].includes(name);

  if (!state.token && !isAuthPage) { location.hash = '#/login'; return; }
  if (state.token && isAuthPage) { location.hash = '#/dashboard'; return; }

  // Carrega o usuário na primeira navegação autenticada
  if (state.token && !state.user) {
    try { state.user = (await api('/auth/me')).user; connectWS(); }
    catch { return; } // token inválido -> logout() já redirecionou
  }

  $('#topbar').hidden = isAuthPage;
  $('#navAdmin').hidden = !state.user?.is_admin;
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
