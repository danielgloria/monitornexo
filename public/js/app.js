/* ═══════════════════════════════════════════════════════════
   MONITOR NEXO — Plataforma de Monitoramento Assistencial v4.0
   Auth: Supabase | SPA hash routing
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────
//  CONFIG & STATE
// ─────────────────────────────────────────────

const API = '/api';

const state = {
  page:         'home',
  utis:         [],
  currentBeds:  [],
  currentUtiId: null,
  checklistCtx: null,
  dischargeCtx: null,
  charts:       {},
  dashFilter:   { utiId: '', start: thirtyDaysAgo(), end: todayISO() },
  recFilter:    { utiId: '', di: thirtyDaysAgo(), df: todayISO(), motivo: '' },
  // Auth
  supabase:     null,
  session:      null,
  currentUser:  null,  // { id, email, full_name, role }
};

// ─────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────

function todayISO() { return new Date().toISOString().split('T')[0]; }
function thirtyDaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 29);
  return d.toISOString().split('T')[0];
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y,m,d] = iso.split('T')[0].split('-');
  return `${d}/${m}/${y}`;
}
function fmtDateTime(dt) {
  if (!dt) return '—';
  const d = new Date(dt.replace(' ','T'));
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}
function calcAge(dob) {
  if (!dob) return '';
  const b = new Date(dob), t = new Date();
  let a = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth()===b.getMonth() && t.getDate()<b.getDate())) a--;
  return a;
}
function fmtNum(n,d=1) { return (n==null||isNaN(n)) ? '—' : Number(n).toFixed(d); }
function pct(p,t)       { return t ? Math.round(p/t*100) : 0; }
function fmtPct(p,t)    { return t ? pct(p,t)+'%' : '—'; }
function escHtml(s) {
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const LABELS = {
  ventilacao:              { nao:'Não', vni:'VNI', vmi:'VM Invasiva' },
  antibiotico:             { nao:'Não', sim:'Sim' },
  dispositivo_venoso:      { nao:'Não', cvc:'CVC', picc:'PICC' },
  sonda_vesical:           { nao:'Não', sim:'Sim' },
  nutricao:                { oral:'Dieta oral', enteral:'Enteral', parenteral:'Parenteral', jejum:'Jejum' },
  vasopressor:             { nao:'Não', sim:'Sim' },
  sedacao:                 { nao:'Não', sim:'Sim' },
  delirium:                { negativo:'Negativo', positivo:'Positivo', nao_avaliado:'Não avaliado' },
  profilaxia_tev:          { farmacologica:'Farmacológica', mecanica:'Mecânica', nao_indicada:'Não indicada', nao_realizada:'Não realizada' },
  profilaxia_ue:           { sim:'Sim', nao:'Não', nao_indicado:'Não indicado' },
  mobilizacao:             { acamado:'Acamado', sedestacao:'Sedestação', ortostatismo:'Ortostatismo', deambulacao:'Deambulação' },
  dispositivos_necessarios:{ sim:'Sim', nao:'Não' },
  previsao_alta:           { alta_hoje:'Alta hoje', alta_24h:'Alta em 24h', alta_48h:'Alta em 48h', alta_72h:'Alta em 72h', sem_previsao:'Sem previsão', paliativos:'Cuidados paliativos' }
};
function lbl(field, val) { return LABELS[field]?.[val] ?? val ?? '—'; }

// ─────────────────────────────────────────────
//  API (with auth token)
// ─────────────────────────────────────────────

async function apiFetch(path, opts={}) {
  const headers = { 'Content-Type': 'application/json' };

  // Attach Supabase auth token
  if (state.session?.access_token) {
    headers['Authorization'] = `Bearer ${state.session.access_token}`;
  }

  const res = await fetch(API+path, { headers, ...opts });
  const data = await res.json().catch(()=>({}));

  // Handle auth_required — redirect to login
  if (data.auth_required) {
    await doLogout();
    return;
  }

  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}
const api = {
  get:    p      => apiFetch(p),
  post:   (p, b) => apiFetch(p, {method:'POST', body:JSON.stringify(b)}),
  put:    (p, b) => apiFetch(p, {method:'PUT',  body:JSON.stringify(b)}),
  delete: p      => apiFetch(p, {method:'DELETE'})
};

// ─────────────────────────────────────────────
//  TOAST
// ─────────────────────────────────────────────

function toast(msg, type='info', ms=3500) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${{success:'✔',error:'✖',info:'ℹ'}[type]||'•'}</span><span>${escHtml(msg)}</span>`;
  c.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300); }, ms);
}

// ─────────────────────────────────────────────
//  MODAL
// ─────────────────────────────────────────────

function openModal(title, html) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').hidden = false;
}
function updateModalBody(html) {
  document.getElementById('modal-body').innerHTML = html;
}
function closeModal() {
  document.getElementById('modal-overlay').hidden = true;
}

// ═══════════════════════════════════════════════════════════
//  AUTH — Supabase Integration
// ═══════════════════════════════════════════════════════════

async function initSupabase() {
  try {
    const config = await fetch('/api/config').then(r => r.json());
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      console.warn('[AUTH] Supabase não configurado');
      return false;
    }
    state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

    // Listen for auth state changes (token refresh, etc.)
    state.supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session) {
        state.session = session;
      }
      if (event === 'SIGNED_OUT') {
        state.session = null;
        state.currentUser = null;
        showAuthScreen();
      }
    });

    return true;
  } catch (e) {
    console.error('[AUTH] Falha ao inicializar Supabase:', e);
    return false;
  }
}

async function checkSession() {
  if (!state.supabase) return false;
  try {
    const { data: { session }, error } = await state.supabase.auth.getSession();
    if (error || !session) return false;

    state.session = session;

    // Get profile from backend
    const profile = await api.get('/auth/me');
    state.currentUser = profile;
    return true;
  } catch (e) {
    console.error('[AUTH] checkSession error:', e);
    return false;
  }
}

function showAuthScreen() {
  document.getElementById('auth-screen').hidden = false;
  document.getElementById('app-shell').hidden = true;
  showLoginForm();
}

function showApp() {
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;
  updateUserUI();
}

function updateUserUI() {
  const user = state.currentUser;
  if (!user) return;

  const initial = (user.full_name || user.email || 'U')[0].toUpperCase();
  const displayName = user.full_name || user.email.split('@')[0];

  const avatar = document.getElementById('user-avatar');
  const name = document.getElementById('user-name');
  const dName = document.getElementById('dropdown-name');
  const dEmail = document.getElementById('dropdown-email');
  const dRole = document.getElementById('dropdown-role');

  if (avatar) avatar.textContent = initial;
  if (name) name.textContent = displayName;
  if (dName) dName.textContent = user.full_name || displayName;
  if (dEmail) dEmail.textContent = user.email;
  if (dRole) dRole.textContent = user.role === 'admin' ? 'Administrador' : 'Usuário';

  // Show/hide admin nav
  const adminNav = document.querySelector('.nav-admin');
  if (adminNav) adminNav.hidden = user.role !== 'admin';
}

// ─── Auth form switching ──────────────────────

function showLoginForm() {
  document.getElementById('login-form').hidden = false;
  document.getElementById('register-form').hidden = true;
  document.getElementById('forgot-form').hidden = true;
  document.getElementById('reset-form').hidden = true;
  clearAuthErrors();
}

function showRegisterForm() {
  document.getElementById('login-form').hidden = true;
  document.getElementById('register-form').hidden = false;
  document.getElementById('forgot-form').hidden = true;
  document.getElementById('reset-form').hidden = true;
  clearAuthErrors();
}

function showForgotForm() {
  document.getElementById('login-form').hidden = true;
  document.getElementById('register-form').hidden = true;
  document.getElementById('forgot-form').hidden = false;
  document.getElementById('reset-form').hidden = true;
  clearAuthErrors();
}

function showResetForm() {
  document.getElementById('login-form').hidden = true;
  document.getElementById('register-form').hidden = true;
  document.getElementById('forgot-form').hidden = true;
  document.getElementById('reset-form').hidden = false;
  clearAuthErrors();
}

function clearAuthErrors() {
  document.querySelectorAll('.auth-error, .auth-success').forEach(el => { el.hidden = true; el.textContent = ''; });
}

function showAuthError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.hidden = false; }
}

function showAuthSuccess(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.hidden = false; }
}

// ─── Login ─────────────────────────────────────

async function doLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-btn');

  clearAuthErrors();
  btn.disabled = true; btn.textContent = 'Entrando...';

  try {
    const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    state.session = data.session;

    // Load profile
    const profile = await api.get('/auth/me');
    state.currentUser = profile;

    showApp();
    updateSidebarDate();

    // Start routing
    window.addEventListener('hashchange', handleRoute);
    if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#login') {
      window.location.hash = 'home';
    } else {
      handleRoute();
    }

    toast(`Bem-vindo, ${profile.full_name || email}!`, 'success');
  } catch (err) {
    const msg = err.message?.includes('Invalid login')
      ? 'Email ou senha incorretos'
      : err.message || 'Erro ao fazer login';
    showAuthError('login-error', msg);
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}

// ─── Register ──────────────────────────────────

async function doRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;
  const terms = document.getElementById('reg-terms').checked;
  const btn = document.getElementById('register-btn');

  clearAuthErrors();

  if (password !== password2) {
    showAuthError('register-error', 'As senhas não coincidem');
    return;
  }
  if (password.length < 6) {
    showAuthError('register-error', 'A senha deve ter no mínimo 6 caracteres');
    return;
  }
  if (!terms) {
    showAuthError('register-error', 'Você deve aceitar os termos de uso');
    return;
  }

  btn.disabled = true; btn.textContent = 'Criando conta...';

  try {
    const { data, error } = await state.supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: name } }
    });

    if (error) throw error;

    if (data.user && !data.session) {
      // Email confirmation required
      showAuthError('register-error', '');
      showLoginForm();
      toast('Conta criada! Verifique seu email para confirmar o cadastro.', 'success', 6000);
    } else if (data.session) {
      // Auto-confirmed
      state.session = data.session;
      const profile = await api.get('/auth/me');
      state.currentUser = profile;
      showApp();
      updateSidebarDate();
      window.addEventListener('hashchange', handleRoute);
      window.location.hash = 'home';
      toast('Conta criada com sucesso! Bem-vindo!', 'success');
    }
  } catch (err) {
    const msg = err.message?.includes('already registered')
      ? 'Este email já está cadastrado'
      : err.message || 'Erro ao criar conta';
    showAuthError('register-error', msg);
  } finally {
    btn.disabled = false; btn.textContent = 'Criar Conta';
  }
}

// ─── Forgot password ───────────────────────────

async function doForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value.trim();
  const btn = document.getElementById('forgot-btn');

  clearAuthErrors();
  btn.disabled = true; btn.textContent = 'Enviando...';

  try {
    const siteUrl = window.location.origin;
    const { error } = await state.supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/#reset-password`
    });
    if (error) throw error;

    showAuthSuccess('forgot-success', 'Link de recuperação enviado! Verifique seu email.');
  } catch (err) {
    showAuthError('forgot-error', err.message || 'Erro ao enviar link');
  } finally {
    btn.disabled = false; btn.textContent = 'Enviar link de recuperação';
  }
}

// ─── Reset password ────────────────────────────

async function doResetPassword(e) {
  e.preventDefault();
  const password = document.getElementById('reset-password').value;
  const password2 = document.getElementById('reset-password2').value;
  const btn = document.getElementById('reset-btn');

  clearAuthErrors();

  if (password !== password2) {
    showAuthError('reset-error', 'As senhas não coincidem');
    return;
  }
  if (password.length < 6) {
    showAuthError('reset-error', 'A senha deve ter no mínimo 6 caracteres');
    return;
  }

  btn.disabled = true; btn.textContent = 'Salvando...';

  try {
    const { error } = await state.supabase.auth.updateUser({ password });
    if (error) throw error;

    showAuthSuccess('reset-success', 'Senha alterada com sucesso! Redirecionando...');
    setTimeout(() => {
      showLoginForm();
      toast('Senha alterada! Faça login com a nova senha.', 'success');
    }, 2000);
  } catch (err) {
    showAuthError('reset-error', err.message || 'Erro ao alterar senha');
  } finally {
    btn.disabled = false; btn.textContent = 'Salvar nova senha';
  }
}

// ─── Logout ────────────────────────────────────

async function doLogout() {
  if (state.supabase) {
    await state.supabase.auth.signOut();
  }
  state.session = null;
  state.currentUser = null;
  window.removeEventListener('hashchange', handleRoute);
  window.location.hash = '';
  showAuthScreen();
}

// ─────────────────────────────────────────────
//  ROUTER
// ─────────────────────────────────────────────

function navigate(hash, ctxUpdate={}) {
  Object.assign(state, ctxUpdate);
  window.location.hash = hash;
}

async function handleRoute() {
  const raw   = window.location.hash.replace('#','') || 'home';
  const parts = raw.split('/');
  const page  = parts[0];
  state.page  = page;

  // Redirect non-admin from admin page
  if (page === 'admin' && state.currentUser?.role !== 'admin') {
    window.location.hash = 'home';
    return;
  }

  // Active nav highlighting
  document.querySelectorAll('.nav-item').forEach(a => {
    const aPage  = a.dataset.page;
    const aUtiId = a.dataset.utiId;
    let active = aPage === page;
    if (page==='uti' && aUtiId && parts[1]===aUtiId) active = true;
    if (page==='checklist') active = false;
    a.classList.toggle('active', active);
  });

  const titles = { home:'Inicio', uti:'Leitos da UTI', checklist:'Checklist Diario', registros:'Registros', dashboard:'Dashboard', admin:'Administração' };
  document.getElementById('topbar-title').textContent = titles[page] || page;

  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="page-loader"><div class="spinner"></div></div>';

  try {
    if      (page==='home')      await renderHome();
    else if (page==='uti')       await renderUTI(parseInt(parts[1]));
    else if (page==='checklist') await renderChecklist(parseInt(parts[2]));
    else if (page==='registros') await renderRegistros();
    else if (page==='dashboard') await renderDashboard();
    else if (page==='admin')     await renderAdmin();
    else main.innerHTML = '<p style="padding:40px;color:var(--text-muted)">Pagina nao encontrada.</p>';
  } catch(err) {
    main.innerHTML = `<div style="padding:40px;color:var(--danger)">Erro ao carregar: ${escHtml(err.message)}</div>`;
    console.error(err);
  }

  refreshSidebar();
}

async function refreshSidebar() {
  try {
    const utis = await api.get('/utis');
    state.utis = utis;
    const totalOcc = utis.reduce((s,u)=>s+(u.ocupados||0), 0);
    const el = document.getElementById('census-count');
    if (el) el.textContent = totalOcc;
    utis.forEach(u => {
      const el = document.getElementById(`nav-uti-${u.id}`);
      if (el) el.textContent = `${u.nome} (${u.ocupados||0}/${u.total_leitos})`;
    });
  } catch(_){}
}

// ─────────────────────────────────────────────
//  HOME PAGE
// ─────────────────────────────────────────────

async function renderHome() {
  const main = document.getElementById('main-content');
  const utis = await api.get('/utis');
  state.utis = utis;

  const cards = utis.map(u => {
    const ocPct = u.total_leitos ? Math.round((u.ocupados/u.total_leitos)*100) : 0;
    return `
      <div class="uti-select-card" onclick="navigate('uti/${u.id}')">
        <div class="uti-icon-wrap"><svg viewBox="0 0 48 48" width="52" height="52" fill="none"><rect x="6" y="8" width="36" height="28" rx="4" stroke="#1B3A5C" stroke-width="2.5"/><rect x="16" y="36" width="16" height="3" rx="1.2" fill="#1B3A5C"/><rect x="12" y="39" width="24" height="2.5" rx="1" fill="#B0BEC5"/><polyline points="11,24 17,24 20,14 24,32 28,20 30,24 37,24" stroke="#5fb8d9" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div class="uti-card-name">${escHtml(u.nome)}</div>
        <div class="uti-card-stats">
          <div class="uti-stat">
            <span class="stat-val occ">${u.ocupados||0}</span>
            <span class="stat-lbl">Ocupados</span>
          </div>
          <div class="uti-stat">
            <span class="stat-val free">${u.vagos||0}</span>
            <span class="stat-lbl">Vagos</span>
          </div>
          <div class="uti-stat">
            <span class="stat-val tot">${u.total_leitos}</span>
            <span class="stat-lbl">Total</span>
          </div>
        </div>
        <div class="uti-occ-bar">
          <div class="uti-occ-fill" style="width:${ocPct}%"></div>
        </div>
        <div class="uti-occ-pct">${ocPct}% ocupado</div>
        <button class="uti-enter-btn">Acessar ${escHtml(u.nome)} →</button>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div class="home-header">
      <h2>Selecione a Unidade</h2>
      <p>${fmtDate(todayISO())} · Plataforma de Monitoramento Assistencial</p>
    </div>
    <div class="uti-selection">${cards}</div>`;
}

// ─────────────────────────────────────────────
//  UTI PAGE — BED GRID
// ─────────────────────────────────────────────

async function renderUTI(utiId) {
  if (!utiId) return navigate('home');
  const main = document.getElementById('main-content');
  state.currentUtiId = utiId;

  const [utis, beds] = await Promise.all([
    api.get('/utis'),
    api.get(`/utis/${utiId}/leitos`)
  ]);
  state.utis        = utis;
  state.currentBeds = beds;
  const uti = utis.find(u=>u.id===utiId) || { nome:`UTI ${utiId}`, total_leitos:0, ocupados:0, vagos:0 };

  const cards = beds.map(b => {
    if (b.ocupado) {
      const age = calcAge(b.data_nascimento);
      return `
        <div class="bed-card ocupado" onclick="openBedModal(${b.id})" title="Clique para gerenciar">
          <div class="bed-number">${escHtml(b.numero)}</div>
          <div class="bed-status-badge ocupado">🔴 Ocupado</div>
          <div class="bed-patient-name">${escHtml(b.nome_paciente)}</div>
          <div class="bed-patient-dob">${fmtDate(b.data_nascimento)}${age?` · ${age}a`:''}</div>
        </div>`;
    } else {
      return `
        <div class="bed-card vago" onclick="openBedModal(${b.id})" title="Clique para internar">
          <div class="bed-number">${escHtml(b.numero)}</div>
          <div class="bed-status-badge vago">🟢 Vago</div>
          <div class="bed-hint">Clique para internar</div>
        </div>`;
    }
  }).join('');

  document.getElementById('topbar-title').textContent = uti.nome;

  main.innerHTML = `
    <div class="uti-page-header">
      <button class="back-btn" onclick="navigate('home')">← Início</button>
      <div class="uti-page-title">${escHtml(uti.nome)}</div>
      <div class="uti-page-meta">
        ${badge(`${uti.ocupados||0} ocupados`, 'info')}
        ${badge(`${uti.vagos||0} vagos`, 'success')}
        ${badge(`${uti.total_leitos} total`, 'neutral')}
      </div>
    </div>
    <div class="bed-grid">${cards}</div>`;
}

function badge(text, type) {
  return `<span class="badge badge-${type}">${escHtml(text)}</span>`;
}

// ─────────────────────────────────────────────
//  BED MODAL
// ─────────────────────────────────────────────

function openBedModal(leitoId) {
  const bed = state.currentBeds.find(b=>b.id===leitoId);
  if (!bed) return toast('Leito não encontrado', 'error');

  const uti = state.utis.find(u=>u.id===bed.uti_id) || {};
  const title = `Leito ${bed.numero} — ${uti.nome||''}`;

  if (bed.ocupado) {
    showOccupiedModal(bed, uti, title);
  } else {
    showVacantModal(bed, uti, title);
  }
}

function showVacantModal(bed, uti, title) {
  openModal(title, `
    <div class="bed-modal-location">${escHtml(uti.nome||'')} · Leito ${escHtml(bed.numero)}</div>
    <div class="vacant-panel">
      <span class="vacant-icon">🛏️</span>
      <p>Leito disponível. Deseja internar um paciente?</p>
      <button class="btn btn-primary" onclick="showAdmitForm(${bed.id}, '${escHtml(bed.numero)}', '${escHtml(uti.nome||'')}')">
        + Internar Paciente
      </button>
    </div>`);
}

function showOccupiedModal(bed, uti, title) {
  const age = calcAge(bed.data_nascimento);
  openModal(title, `
    <div class="bed-modal-location">${escHtml(uti.nome||'')} · Leito ${escHtml(bed.numero)}</div>
    <div class="patient-panel">
      <div class="pp-name">👤 ${escHtml(bed.nome_paciente)}</div>
      <div class="pp-row">🎂 ${fmtDate(bed.data_nascimento)}${age?` &nbsp;·&nbsp; ${age} anos`:''}</div>
      <div class="pp-row">📅 Internado em ${fmtDateTime(bed.data_entrada)}</div>
    </div>
    <div class="bed-modal-actions">
      <button class="btn btn-teal" onclick="goChecklistFromBed(${bed.id}, ${bed.ocupacao_id}, '${escHtml(bed.nome_paciente)}', '${escHtml(bed.numero)}', '${escHtml(uti.nome||'')}')">
        ✅ Abrir Checklist
      </button>
      <button class="btn btn-danger" onclick="showDischargeStep1(${bed.ocupacao_id}, ${bed.id}, '${escHtml(bed.nome_paciente)}', ${uti.id||0})">
        🚪 Retirar do Leito
      </button>
    </div>`);
}

// ─── Admit patient ────────────────────────────

function showAdmitForm(leitoId, leitoNumero, utiNome) {
  updateModalBody(`
    <div class="bed-modal-location">${escHtml(utiNome)} · Leito ${escHtml(leitoNumero)}</div>
    <form class="admit-form" id="admit-form">
      <div class="form-grid" style="grid-template-columns:1fr">
        <div class="form-group">
          <label>Nome completo <span class="req">*</span></label>
          <input class="form-control" name="nome_paciente" required
            placeholder="Nome completo do paciente" autofocus />
        </div>
        <div class="form-group">
          <label>Data de nascimento <span class="req">*</span></label>
          <input class="form-control" type="date" name="data_nascimento" required max="${todayISO()}" />
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button type="button" class="btn btn-outline" onclick="closeModal()">Cancelar</button>
        <button type="submit" class="btn btn-primary">Confirmar Internação</button>
      </div>
    </form>`);

  document.getElementById('admit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Internando...';
    try {
      const r = await api.post(`/leitos/${leitoId}/internar`, Object.fromEntries(fd));
      toast(r.message, 'success');
      closeModal();
      await renderUTI(state.currentUtiId);
    } catch(err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'Confirmar Internação';
    }
  });
}

// ─── Discharge flow ───────────────────────────

function showDischargeStep1(ocupacaoId, leitoId, nomePaciente, utiId) {
  state.dischargeCtx = { ocupacaoId, leitoId, utiId, motivo: null };

  updateModalBody(`
    <div class="discharge-step">
      <h4>Retirar do leito — <em>${escHtml(nomePaciente)}</em></h4>
      <p style="font-size:.85rem;color:var(--text-muted);margin-bottom:12px">Selecione o motivo da saída:</p>
      <div class="motivo-grid">
        <div class="motivo-card" id="m-alta" onclick="selectMotivo('alta')">
          <span class="m-icon">🏠</span>
          <div class="m-label">Alta da UTI</div>
          <div class="m-sub">Paciente recebeu alta</div>
        </div>
        <div class="motivo-card" id="m-obito" onclick="selectMotivo('obito')">
          <span class="m-icon">✝️</span>
          <div class="m-label">Óbito</div>
          <div class="m-sub">Registrar óbito</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-outline" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-danger" id="btn-discharge-next" disabled
          onclick="showDischargeConfirm('${escHtml(nomePaciente)}')">
          Continuar →
        </button>
      </div>
    </div>`);
}

function selectMotivo(motivo) {
  state.dischargeCtx.motivo = motivo;
  document.querySelectorAll('.motivo-card').forEach(c => c.classList.remove('active','red'));
  const el = document.getElementById(`m-${motivo}`);
  if (el) { el.classList.add('active'); if (motivo==='obito') el.classList.add('red'); }
  const btn = document.getElementById('btn-discharge-next');
  if (btn) btn.disabled = false;
}

function showDischargeConfirm(nomePaciente) {
  const motivo = state.dischargeCtx.motivo;
  if (!motivo) return toast('Selecione o motivo', 'error');
  const mLabel = motivo==='alta' ? 'Alta da UTI' : 'Óbito';
  updateModalBody(`
    <div class="confirm-discharge">
      <strong>⚠ Confirme a saída</strong><br/>
      Você está registrando a saída de <strong>${escHtml(nomePaciente)}</strong>
      por motivo: <strong>${escHtml(mLabel)}</strong>.<br/>
      Esta ação não pode ser desfeita.
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-outline" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-danger" id="btn-discharge-confirm" onclick="executeDischarge()">
        Confirmar Saída
      </button>
    </div>`);
}

async function executeDischarge() {
  const { ocupacaoId, utiId, motivo } = state.dischargeCtx;
  const btn = document.getElementById('btn-discharge-confirm');
  if (btn) { btn.disabled=true; btn.textContent='Registrando...'; }
  try {
    const r = await api.post(`/ocupacoes/${ocupacaoId}/saida`, { motivo_saida: motivo });
    toast(r.message, 'success');
    closeModal();
    state.dischargeCtx = null;
    await renderUTI(state.currentUtiId);
  } catch(err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled=false; btn.textContent='Confirmar Saída'; }
  }
}

// ─── Go to checklist from bed modal ──────────

function goChecklistFromBed(leitoId, ocupacaoId, nomePaciente, leitoNumero, utiNome) {
  state.checklistCtx = { leitoId, ocupacaoId, nomePaciente, leitoNumero, utiNome };
  closeModal();
  navigate(`checklist/leito/${leitoId}`);
}

// ─────────────────────────────────────────────
//  CHECKLIST PAGE
// ─────────────────────────────────────────────

async function renderChecklist(leitoId) {
  const main = document.getElementById('main-content');

  let ctx = state.checklistCtx;
  if (!ctx || ctx.leitoId !== leitoId) {
    const utis  = await api.get('/utis');
    let   found = null;
    for (const u of utis) {
      const beds = await api.get(`/utis/${u.id}/leitos`);
      const b    = beds.find(b=>b.id===leitoId);
      if (b) {
        found = { uti:u, bed:b };
        if (!state.currentBeds.length || state.currentUtiId!==u.id) {
          state.currentBeds  = beds;
          state.currentUtiId = u.id;
        }
        break;
      }
    }
    if (!found || !found.bed.ocupado) {
      main.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🛏️</span>
          <h3>Leito sem paciente internado</h3>
          <p>Não é possível preencher checklist em leito vago.</p>
          <button class="btn btn-primary" onclick="history.back()">← Voltar</button>
        </div>`;
      return;
    }
    ctx = {
      leitoId,
      ocupacaoId:    found.bed.ocupacao_id,
      nomePaciente:  found.bed.nome_paciente,
      leitoNumero:   found.bed.numero,
      utiNome:       found.uti.nome
    };
    state.checklistCtx = ctx;
  }

  const selDate = todayISO();

  main.innerHTML = `
    <div class="checklist-form" id="checklist-wrapper">
      <div class="card" style="margin-bottom:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <button class="back-btn" onclick="navigate('uti/${state.currentUtiId||1}')">← ${escHtml(ctx.utiNome||'UTI')}</button>
        <div style="flex:1">
          <div style="font-weight:700;font-size:1rem">Checklist — Leito ${escHtml(ctx.leitoNumero)}</div>
          <div style="font-size:.82rem;color:var(--text-muted)">👤 ${escHtml(ctx.nomePaciente)}</div>
        </div>
        <div class="form-group" style="margin:0">
          <label style="font-size:.72rem">Data do Registro</label>
          <input class="form-control" type="date" id="cl-date" value="${selDate}" max="${todayISO()}" />
        </div>
      </div>
      <div id="existing-alert"></div>

      <form id="checklist-form">

        ${clSection('🫁','Suporte Ventilatório',`
          ${clRow('ventilacao','Ventilação Mecânica',[
            {v:'nao',l:'Não'},{v:'vni',l:'VNI',c:'warning'},{v:'vmi',l:'VM Invasiva',c:'danger'}])}
          <div class="cl-sub hidden" id="sub-ventilacao">
            <label>Dia de VM:</label>
            <input type="number" name="dia_ventilacao" id="dia_ventilacao" min="1" max="999" placeholder="0"/>
            <span>dias</span>
          </div>
        `)}

        ${clSection('💊','Antimicrobiano',`
          ${clRow('antibiotico','Antibiótico em uso',[
            {v:'nao',l:'Não'},{v:'sim',l:'Sim',c:'danger'}])}
          <div class="cl-sub hidden" id="sub-antibiotico">
            <label>Dia de ATB:</label>
            <input type="number" name="dia_antibiotico" id="dia_antibiotico" min="1" max="999" placeholder="0"/>
            <span>dias</span>
          </div>
          <div class="cl-row">
            <div class="cl-label">Reavaliação do Antibiótico</div>
            <div class="btn-group btn-group-multi" data-group="reavaliacao_atb" data-max="4">
              <button type="button" class="btn-option" data-field="reavaliacao_atb" data-value="empirico" data-color="primary">Empírico inicial</button>
              <button type="button" class="btn-option" data-field="reavaliacao_atb" data-value="cultura" data-color="teal">Direcionado por cultura</button>
              <button type="button" class="btn-option" data-field="reavaliacao_atb" data-value="escalonado" data-color="warning">Escalonado</button>
              <button type="button" class="btn-option" data-field="reavaliacao_atb" data-value="descalonado" data-color="success">Descalonado</button>
              <button type="button" class="btn-option" data-field="reavaliacao_atb" data-value="suspenso" data-color="danger">Suspenso hoje</button>
              <button type="button" class="btn-option" data-field="reavaliacao_atb" data-value="reavaliar48h" data-color="warning">Reavaliar em 48h</button>
            </div>
          </div>
        `)}

        ${clSection('🩺','Dispositivos Invasivos',`
          ${clRow('dispositivo_venoso','Dispositivo Venoso Central',[
            {v:'nao',l:'Não'},{v:'cvc',l:'CVC',c:'warning'},{v:'picc',l:'PICC',c:'warning'}])}
          ${clRow('sonda_vesical','Sonda Vesical de Demora',[
            {v:'nao',l:'Não'},{v:'sim',l:'Sim',c:'warning'}])}
          ${clRow('dispositivos_necessarios','Dispositivos ainda necessários',[
            {v:'sim',l:'Sim',c:'success'},{v:'nao',l:'Não',c:'danger'}])}
          <div class="cl-row cl-devices-days">
            <div class="cl-label">Tempo de uso dos dispositivos</div>
            <div class="cl-num-fields">
              <div class="cl-num-field">
                <label>Dias de VM</label>
                <input type="number" id="dias_vm" name="dias_vm" min="0" max="999" placeholder="0"/>
              </div>
              <div class="cl-num-field">
                <label>Dias de CVC</label>
                <input type="number" id="dias_cvc" name="dias_cvc" min="0" max="999" placeholder="0"/>
              </div>
              <div class="cl-num-field">
                <label>Dias de Sonda Vesical</label>
                <input type="number" id="dias_sonda" name="dias_sonda" min="0" max="999" placeholder="0"/>
              </div>
            </div>
          </div>
        `)}

        ${clSection('💉','Suporte Hemodinâmico & Nutricional',`
          ${clRow('vasopressor','Uso de Vasopressor',[
            {v:'nao',l:'Não'},{v:'sim',l:'Sim',c:'danger'}])}
          ${clRow('nutricao','Nutrição',[
            {v:'oral',l:'Dieta Oral'},{v:'enteral',l:'Enteral',c:'teal'},
            {v:'parenteral',l:'Parenteral',c:'warning'},{v:'jejum',l:'Jejum',c:'danger'}])}
          ${clRow('sedacao','Sedação Contínua',[
            {v:'nao',l:'Não'},{v:'sim',l:'Sim',c:'warning'}])}
        `)}

        ${clSection('🧠','Avaliação Neurológica',`
          ${clRow('delirium','Delirium (CAM-ICU)',[
            {v:'negativo',l:'Negativo',c:'success'},
            {v:'positivo',l:'Positivo',c:'danger'},
            {v:'nao_avaliado',l:'Não avaliado',c:'warning'}])}
        `)}

        ${clSection('🛡️','Pacote de Segurança',`
          ${clRow('profilaxia_tev','Profilaxia de TEV',[
            {v:'farmacologica',l:'Farmacológica',c:'success'},{v:'mecanica',l:'Mecânica',c:'teal'},
            {v:'nao_indicada',l:'Não indicada'},{v:'nao_realizada',l:'Não realizada',c:'danger'}])}
          ${clRow('profilaxia_ue','Profilaxia Úlcera Estresse',[
            {v:'sim',l:'Sim',c:'success'},{v:'nao',l:'Não',c:'danger'},{v:'nao_indicado',l:'Não indicado'}])}
          ${clRow('mobilizacao','Mobilização do Paciente',[
            {v:'acamado',l:'Acamado',c:'danger'},{v:'sedestacao',l:'Sedestação',c:'warning'},
            {v:'ortostatismo',l:'Ortostatismo',c:'teal'},{v:'deambulacao',l:'Deambulação',c:'success'}])}
        `)}

        ${clSection('📋','Planejamento Assistencial',`
          ${clRow('previsao_alta','Previsão de Alta da UTI',[
            {v:'alta_hoje',l:'Alta hoje',c:'success'},
            {v:'alta_24h',l:'Alta em 24h',c:'teal'},
            {v:'alta_48h',l:'Alta em 48h',c:'warning'},
            {v:'alta_72h',l:'Alta em 72h',c:'warning'},
            {v:'sem_previsao',l:'Sem previsão',c:'danger'},
            {v:'paliativos',l:'Cuidados paliativos',c:'neutral'}])}
        `)}

        <div class="cl-footer">
          <div class="form-group">
            <label>Profissional Responsável <span class="req">*</span></label>
            <input class="form-control" name="profissional" id="cl-profissional"
              required placeholder="Nome completo / COREN" />
          </div>
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end;margin-bottom:8px">
          <button type="button" class="btn btn-outline"
            onclick="navigate('uti/${state.currentUtiId||1}')">Cancelar</button>
          <button type="submit" class="btn btn-teal" id="cl-submit-btn">💾 Salvar Checklist</button>
        </div>
      </form>
    </div>`;

  setupBtnGroups();

  const doLoad = () => loadExistingChecklist(ctx.ocupacaoId, document.getElementById('cl-date').value);
  document.getElementById('cl-date').addEventListener('change', doLoad);
  await loadExistingChecklist(ctx.ocupacaoId, selDate);
  document.getElementById('checklist-form').addEventListener('submit', saveChecklist);
}

// ─── Checklist helpers ──────────────────────

function clSection(icon, title, body) {
  return `<div class="cl-section">
    <div class="cl-section-header"><span class="section-icon">${icon}</span><span>${escHtml(title)}</span></div>
    <div class="cl-body">${body}</div>
  </div>`;
}
function clRow(field, labelText, options) {
  const btns = options.map(o=>
    `<button type="button" class="btn-option" data-field="${field}" data-value="${o.v}" data-color="${o.c||'primary'}">${escHtml(o.l)}</button>`
  ).join('');
  return `<div class="cl-row">
    <div class="cl-label">${escHtml(labelText)} <span class="required">*</span></div>
    <div class="btn-group" data-group="${field}">${btns}</div>
  </div>`;
}
function setupBtnGroups() {
  document.querySelectorAll('.btn-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.field, color = btn.dataset.color||'primary';
      const group = btn.closest('.btn-group');
      const isMulti = group && group.classList.contains('btn-group-multi');

      if (isMulti) {
        const maxSel = parseInt(group.dataset.max||'99');
        if (btn.classList.contains('active')) {
          btn.classList.remove('active','success','danger','warning','teal');
        } else {
          const activeCount = group.querySelectorAll('.btn-option.active').length;
          if (activeCount >= maxSel) return;
          btn.classList.add('active', color);
        }
      } else {
        document.querySelectorAll(`.btn-option[data-field="${field}"]`).forEach(b=>{
          b.classList.remove('active','success','danger','warning','teal');
        });
        btn.classList.add('active', color);
      }
      if (field==='ventilacao') document.getElementById('sub-ventilacao')?.classList.toggle('hidden', btn.dataset.value!=='vmi');
      if (field==='antibiotico') document.getElementById('sub-antibiotico')?.classList.toggle('hidden', btn.dataset.value!=='sim');
    });
  });
}
function setChecklistValues(data) {
  const fields = ['ventilacao','antibiotico','dispositivo_venoso','sonda_vesical','nutricao',
    'vasopressor','sedacao','delirium','profilaxia_tev','profilaxia_ue','mobilizacao',
    'dispositivos_necessarios','previsao_alta'];
  fields.forEach(f => {
    if (!data[f]) return;
    document.querySelector(`.btn-option[data-field="${f}"][data-value="${data[f]}"]`)?.click();
  });
  if (data.reavaliacao_atb) {
    data.reavaliacao_atb.split(',').forEach(v => {
      document.querySelector(`.btn-option[data-field="reavaliacao_atb"][data-value="${v.trim()}"]`)?.click();
    });
  }
  if (data.dia_ventilacao)  { const el=document.getElementById('dia_ventilacao');  if(el) el.value=data.dia_ventilacao; }
  if (data.dia_antibiotico) { const el=document.getElementById('dia_antibiotico'); if(el) el.value=data.dia_antibiotico; }
  if (data.dias_vm)    { const el=document.getElementById('dias_vm');    if(el) el.value=data.dias_vm; }
  if (data.dias_cvc)   { const el=document.getElementById('dias_cvc');   if(el) el.value=data.dias_cvc; }
  if (data.dias_sonda) { const el=document.getElementById('dias_sonda'); if(el) el.value=data.dias_sonda; }
  if (data.profissional)    { const el=document.getElementById('cl-profissional');  if(el) el.value=data.profissional; }
}
function getChecklistValues() {
  const data = {};
  ['ventilacao','antibiotico','dispositivo_venoso','sonda_vesical','nutricao','vasopressor',
   'sedacao','delirium','profilaxia_tev','profilaxia_ue','mobilizacao','dispositivos_necessarios',
   'previsao_alta'].forEach(f => {
    const active = document.querySelector(`.btn-option[data-field="${f}"].active`);
    data[f] = active ? active.dataset.value : null;
  });
  const reavBtns = document.querySelectorAll('.btn-option[data-field="reavaliacao_atb"].active');
  data.reavaliacao_atb = reavBtns.length ? Array.from(reavBtns).map(b=>b.dataset.value).join(',') : null;
  return data;
}

async function loadExistingChecklist(ocupacaoId, date) {
  const alertEl = document.getElementById('existing-alert');
  if (!alertEl) return;
  alertEl.innerHTML = '';
  try {
    const existing = await api.get(`/checklists/ocupacao/${ocupacaoId}/data/${date}`);
    if (existing) {
      alertEl.innerHTML = `<div class="alert alert-info" style="margin-bottom:12px">📋 Checklist já preenchido para esta data. Dados carregados — você pode atualizar e salvar novamente.</div>`;
      setChecklistValues(existing);
      const btn = document.getElementById('cl-submit-btn');
      if (btn) btn.textContent = '✏️ Atualizar Checklist';
    } else {
      document.querySelectorAll('.btn-option').forEach(b=>b.classList.remove('active','success','danger','warning','teal'));
      document.querySelectorAll('#dia_ventilacao,#dia_antibiotico,#dias_vm,#dias_cvc,#dias_sonda').forEach(el=>el.value='');
      document.getElementById('sub-ventilacao')?.classList.add('hidden');
      document.getElementById('sub-antibiotico')?.classList.add('hidden');
      const btn = document.getElementById('cl-submit-btn');
      if (btn) btn.textContent = '💾 Salvar Checklist';
    }
  } catch(_){}
}

async function saveChecklist(e) {
  e.preventDefault();
  const ctx        = state.checklistCtx;
  const date       = document.getElementById('cl-date').value;
  const profissional = document.getElementById('cl-profissional').value.trim();
  const values     = getChecklistValues();

  const required = ['ventilacao','antibiotico','dispositivo_venoso','sonda_vesical','nutricao',
    'vasopressor','sedacao','delirium','profilaxia_tev','profilaxia_ue','mobilizacao','dispositivos_necessarios'];
  const missing = required.filter(f=>!values[f]);
  if (missing.length) {
    toast(`Preencha todos os campos obrigatórios (${missing.length} pendente(s))`, 'error', 4000);
    missing.forEach(f=>{ const g=document.querySelector(`.btn-group[data-group="${f}"]`); if(g){g.style.outline='2px solid var(--danger)';g.style.borderRadius='8px';} });
    return;
  }
  document.querySelectorAll('.btn-group').forEach(g=>g.style.outline='');
  if (!profissional) { toast('Informe o profissional responsável','error'); return; }

  const btn = document.getElementById('cl-submit-btn');
  btn.disabled=true; btn.textContent='Salvando...';

  try {
    const body = {
      ocupacao_id: ctx.ocupacaoId, leito_id: ctx.leitoId, data_registro: date, profissional,
      ...values,
      dia_ventilacao:  values.ventilacao==='vmi'  ? (document.getElementById('dia_ventilacao').value||null)  : null,
      dia_antibiotico: values.antibiotico==='sim' ? (document.getElementById('dia_antibiotico').value||null) : null,
      dias_vm:    document.getElementById('dias_vm').value||null,
      dias_cvc:   document.getElementById('dias_cvc').value||null,
      dias_sonda: document.getElementById('dias_sonda').value||null
    };
    const r = await api.post('/checklists', body);
    toast(r.message||'Salvo com sucesso!', 'success');
    const alertEl = document.getElementById('existing-alert');
    if (alertEl) alertEl.innerHTML=`<div class="alert alert-success" style="margin-bottom:12px">✔ ${escHtml(r.message||'Salvo')}</div>`;
    btn.textContent = '✏️ Atualizar Checklist';
  } catch(err) {
    toast(err.message, 'error');
    btn.textContent = '💾 Salvar Checklist';
  } finally { btn.disabled=false; }
}

// ─────────────────────────────────────────────
//  RECORDS PAGE
// ─────────────────────────────────────────────

async function renderRegistros() {
  const main = document.getElementById('main-content');
  const utis = await api.get('/utis');
  state.utis = utis;

  const { utiId, di, df, motivo } = state.recFilter;
  const utiOpts = [
    '<option value="">Todas as UTIs</option>',
    ...utis.map(u=>`<option value="${u.id}" ${u.id==utiId?'selected':''}>${escHtml(u.nome)}</option>`)
  ].join('');

  main.innerHTML = `
    <div class="filter-bar">
      <div class="filter-group">
        <label>UTI</label>
        <select id="rec-uti">${utiOpts}</select>
      </div>
      <div class="filter-group">
        <label>Data início</label>
        <input type="date" id="rec-di" value="${di}" />
      </div>
      <div class="filter-group">
        <label>Data fim</label>
        <input type="date" id="rec-df" value="${df}" />
      </div>
      <div class="filter-group">
        <label>Motivo saída</label>
        <select id="rec-motivo">
          <option value="">Todos</option>
          <option value="alta"  ${motivo==='alta'?'selected':''}>Alta</option>
          <option value="obito" ${motivo==='obito'?'selected':''}>Óbito</option>
          <option value="ativa" ${motivo==='ativa'?'selected':''}>Internado (ativo)</option>
        </select>
      </div>
      <button class="btn btn-primary" id="rec-filter-btn">Filtrar</button>
      <button class="btn btn-outline" id="rec-export-btn">⬇ CSV</button>
    </div>
    <div id="rec-table-wrap">
      <div class="page-loader"><div class="spinner"></div></div>
    </div>`;

  document.getElementById('rec-filter-btn').addEventListener('click', async ()=>{
    state.recFilter.utiId  = document.getElementById('rec-uti').value;
    state.recFilter.di     = document.getElementById('rec-di').value;
    state.recFilter.df     = document.getElementById('rec-df').value;
    state.recFilter.motivo = document.getElementById('rec-motivo').value;
    await loadHistoricoTable();
  });
  document.getElementById('rec-export-btn').addEventListener('click', ()=>{
    const { utiId, di, df } = state.recFilter;
    let url = `${API}/export/csv?data_inicio=${di}&data_fim=${df}`;
    if (utiId) url+=`&uti_id=${utiId}`;
    window.location.href = url;
  });

  await loadHistoricoTable();
}

async function loadHistoricoTable() {
  const wrap = document.getElementById('rec-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="page-loader"><div class="spinner"></div></div>';

  const { utiId, di, df, motivo } = state.recFilter;
  let url = `/historico?data_inicio=${di}&data_fim=${df}`;
  if (utiId)  url+=`&uti_id=${utiId}`;
  if (motivo && motivo!=='ativa') url+=`&motivo_saida=${motivo}`;

  try {
    let records = await api.get(url);
    if (motivo==='ativa') records = records.filter(r=>r.ativa);

    if (!records.length) {
      wrap.innerHTML=`<div class="empty-state"><span class="empty-icon">📋</span><h3>Nenhum registro encontrado</h3><p>Ajuste os filtros para ver o histórico de movimentações.</p></div>`;
      return;
    }

    const rows = records.map(r => {
      const motivoBadge = r.ativa
        ? '<span class="badge motivo-badge-ativa">Internado</span>'
        : r.motivo_saida==='alta'
          ? '<span class="badge motivo-badge-alta">Alta</span>'
          : '<span class="badge motivo-badge-obito">Óbito</span>';
      const age = calcAge(r.data_nascimento);
      return `
        <tr>
          <td><strong>${escHtml(r.uti_nome)}</strong></td>
          <td style="text-align:center;font-weight:700">${escHtml(r.leito_numero)}</td>
          <td>
            <div style="font-weight:600">${escHtml(r.nome_paciente)}</div>
            <div style="font-size:.75rem;color:var(--text-muted)">${fmtDate(r.data_nascimento)}${age?` · ${age}a`:''}</div>
          </td>
          <td>${fmtDateTime(r.data_entrada)}</td>
          <td>${r.data_saida ? fmtDateTime(r.data_saida) : '<span style="color:var(--text-light)">—</span>'}</td>
          <td>${motivoBadge}</td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `
      <p class="records-meta">${records.length} registro(s) encontrado(s)</p>
      <div class="table-wrap" style="overflow-x:auto">
        <table>
          <thead><tr>
            <th>UTI</th><th>Leito</th><th>Paciente</th>
            <th>Entrada</th><th>Saída</th><th>Status/Motivo</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch(err) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--danger)">Erro: ${escHtml(err.message)}</div>`;
  }
}

// ─────────────────────────────────────────────
//  DASHBOARD PAGE
// ─────────────────────────────────────────────

async function renderDashboard() {
  const main = document.getElementById('main-content');
  const utis = await api.get('/utis');
  state.utis = utis;

  const { utiId, start, end } = state.dashFilter;
  const utiOpts = [
    '<option value="">Todas as UTIs</option>',
    ...utis.map(u=>`<option value="${u.id}" ${u.id==utiId?'selected':''}>${escHtml(u.nome)}</option>`)
  ].join('');

  const data = await api.get(`/dashboard?uti_id=${utiId}&data_inicio=${start}&data_fim=${end}`);
  const s    = data.hoje_stats || {};
  const tot  = s.total || 0;

  main.innerHTML = `
    <div class="filter-bar">
      <div class="filter-group">
        <label>UTI</label>
        <select id="dash-uti">${utiOpts}</select>
      </div>
      <div class="filter-group"><label>Início</label><input type="date" id="dash-start" value="${start}"/></div>
      <div class="filter-group"><label>Fim</label><input type="date" id="dash-end" value="${end}"/></div>
      <button class="btn btn-primary" id="dash-filter-btn">Filtrar</button>
      <button class="btn btn-outline" id="dash-export-btn">⬇ CSV</button>
    </div>

    <div class="section-title">Ocupação por Unidade</div>
    <div class="occ-grid">
      ${(data.occ_stats||[]).map(u=>{
        const pct = u.total ? Math.round(u.ocupados/u.total*100) : 0;
        return `
          <div class="occ-card">
            <div class="occ-card-title">${escHtml(u.nome)}</div>
            <div class="occ-numbers">
              <div class="occ-num occ"><span class="n-val">${u.ocupados||0}</span><span class="n-lbl">Ocupados</span></div>
              <div class="occ-num free"><span class="n-val">${u.vagos||0}</span><span class="n-lbl">Vagos</span></div>
              <div class="occ-num tot"><span class="n-val">${u.total}</span><span class="n-lbl">Total</span></div>
            </div>
            <div class="occ-bar"><div class="occ-bar-fill" style="width:${pct}%"></div></div>
            <div class="occ-pct">${pct}% taxa de ocupação</div>
          </div>`;
      }).join('')}
    </div>

    <div class="section-title" style="margin-top:8px">Indicadores do Período (${fmtDate(start)} – ${fmtDate(end)})</div>

    <div class="kpi-section-label">Resumo Geral</div>
    <div class="kpi-grid kpi-grid-4">
      ${kpiCard('Pacientes Ativos', data.totalPacientes, '', 'primary')}
      ${kpiCard('Checklists no Período', data.checklist_count_periodo||0, '', 'teal',
        `${data.checklist_count_hoje||0} preenchido${data.checklist_count_hoje!==1?'s':''} hoje`)}
      ${(()=>{
        const c = data.checklist_count_hoje||0, p = data.totalPacientes||0;
        const pct = p ? Math.round(c/p*100) : 0;
        const col = pct>=80?'success':pct>=50?'warning':'danger';
        const sub = p ? `${c} de ${p} paciente${p!==1?'s':''}` : 'sem pacientes';
        return kpiCard('Preenchimento Hoje', pct+'%', '', col, sub);
      })()}
      ${kpiCard('Permanência Média', data.avg_los?fmtNum(data.avg_los):'—', 'dias', 'neutral')}
    </div>

    <div class="kpi-section-label">Ventilação &amp; Antibioticoterapia</div>
    <div class="kpi-grid kpi-grid-4">
      ${kpiCard('Taxa VM Invasiva', fmtPct(s.ventilados_vmi,tot), '', 'warning', tot?`${s.ventilados_vmi||0} de ${tot} checklists`:'')}
      ${kpiCard('Média Dias VM', s.media_dias_vm?fmtNum(s.media_dias_vm):'—', tot?'dias':'', 'warning')}
      ${kpiCard('Taxa Antibiótico', fmtPct(s.uso_atb,tot), '', 'danger', tot?`${s.uso_atb||0} de ${tot} checklists`:'')}
      ${kpiCard('Média Dias ATB', s.media_dias_atb?fmtNum(s.media_dias_atb):'—', tot?'dias':'', 'danger')}
    </div>

    <div class="kpi-section-label">Dispositivos Invasivos</div>
    <div class="kpi-grid kpi-grid-3">
      ${kpiCard('Disp. Venoso Central', fmtPct(s.uso_dvc,tot), '', 'info', tot?`${s.uso_dvc||0} de ${tot} checklists`:'')}
      ${kpiCard('Sonda Vesical', fmtPct(s.uso_svd,tot), '', 'info', tot?`${s.uso_svd||0} de ${tot} checklists`:'')}
      ${kpiCard('Vasopressor', fmtPct(s.uso_vaso,tot), '', 'danger', tot?`${s.uso_vaso||0} de ${tot} checklists`:'')}
    </div>

    <div class="kpi-section-label">Segurança &amp; Reabilitação</div>
    <div class="kpi-grid kpi-grid-3">
      ${kpiCard('Delirium +', fmtPct(s.delirium_pos,tot), '', 'warning', tot?`${s.delirium_pos||0} de ${tot} checklists`:'')}
      ${kpiCard('Mobilização Precoce', fmtPct(s.mobilizados,tot), '', 'success', tot?`${s.mobilizados||0} de ${tot} checklists`:'')}
      ${kpiCard('Profilaxia TEV', fmtPct(s.prof_tev_ok,tot), '', 'success', tot?`${s.prof_tev_ok||0} de ${tot} checklists`:'')}
    </div>

    ${renderPrevisaoAlta(data.previsao_alta || {})}

    <div class="charts-grid">
      <div class="chart-card chart-card--wide"><h3>📋 Adesão ao Checklist (%)</h3><canvas id="chart-preenchimento"></canvas></div>
      <div class="chart-card"><h3>📈 VM Invasiva &amp; Antibiótico (%)</h3><canvas id="chart-vm-atb"></canvas></div>
      <div class="chart-card"><h3>📈 Delirium &amp; Mobilização (%)</h3><canvas id="chart-del-mob"></canvas></div>
      <div class="chart-card"><h3>📈 Vasopressor &amp; Disp. Venoso (%)</h3><canvas id="chart-vaso-dvc"></canvas></div>
      <div class="chart-card"><h3>📈 Sonda Vesical &amp; Profilaxia TEV (%)</h3><canvas id="chart-svd-tev"></canvas></div>
    </div>`;

  document.getElementById('dash-filter-btn').addEventListener('click', async ()=>{
    state.dashFilter.utiId = document.getElementById('dash-uti').value;
    state.dashFilter.start = document.getElementById('dash-start').value;
    state.dashFilter.end   = document.getElementById('dash-end').value;
    await renderDashboard();
  });
  document.getElementById('dash-export-btn').addEventListener('click', ()=>{
    const { utiId, start, end } = state.dashFilter;
    let url = `${API}/export/csv?data_inicio=${start}&data_fim=${end}`;
    if (utiId) url+=`&uti_id=${utiId}`;
    window.location.href = url;
  });

  drawTrendCharts(data.trends||[]);
}

function renderPrevisaoAlta(pa) {
  const resumo = pa.resumo || {};
  const pacientes = pa.pacientes || [];

  const cats = [
    { key:'alta_hoje',     label:'Alta hoje',           icon:'🟢', color:'success' },
    { key:'alta_24h',      label:'Alta em 24h',         icon:'🔵', color:'teal' },
    { key:'alta_48h',      label:'Alta em 48h',         icon:'🟡', color:'warning' },
    { key:'alta_72h',      label:'Alta em 72h',         icon:'🟠', color:'warning' },
    { key:'sem_previsao',  label:'Sem previsão',        icon:'🔴', color:'danger' },
    { key:'paliativos',    label:'Cuidados paliativos', icon:'🟣', color:'neutral' }
  ];

  const totalComPrevisao = pacientes.length;
  const comAlta = (resumo.alta_hoje||0) + (resumo.alta_24h||0) + (resumo.alta_48h||0) + (resumo.alta_72h||0);

  const kpis = cats.map(c =>
    `<div class="kpi-card ${c.color}">
      <div class="kpi-label">${c.icon} ${escHtml(c.label)}</div>
      <div class="kpi-value">${resumo[c.key]||0}</div>
      <div class="kpi-sub">paciente${(resumo[c.key]||0)!==1?'s':''}</div>
    </div>`
  ).join('');

  const pacComAlta = pacientes.filter(p =>
    ['alta_hoje','alta_24h','alta_48h','alta_72h'].includes(p.previsao_alta)
  );
  const pacSemAlta = pacientes.filter(p =>
    ['sem_previsao','paliativos'].includes(p.previsao_alta)
  );
  const todosOrdenados = [...pacComAlta, ...pacSemAlta];

  const previsaoLabel = {
    alta_hoje:'Alta hoje', alta_24h:'Alta em 24h', alta_48h:'Alta em 48h',
    alta_72h:'Alta em 72h', sem_previsao:'Sem previsão', paliativos:'Cuidados paliativos'
  };
  const previsaoColor = {
    alta_hoje:'success', alta_24h:'teal', alta_48h:'warning',
    alta_72h:'warning', sem_previsao:'danger', paliativos:'neutral'
  };

  let tabelaHtml = '';
  if (todosOrdenados.length) {
    const rows = todosOrdenados.map(p => {
      const badgeColor = previsaoColor[p.previsao_alta] || 'neutral';
      const badgeLabel = previsaoLabel[p.previsao_alta] || p.previsao_alta || '—';
      return `<tr>
        <td><strong>${escHtml(p.nome_paciente)}</strong></td>
        <td style="text-align:center">${escHtml(p.leito_numero)}</td>
        <td>${escHtml(p.uti_nome)}</td>
        <td><span class="badge badge-${badgeColor}">${escHtml(badgeLabel)}</span></td>
      </tr>`;
    }).join('');
    tabelaHtml = `
      <div class="table-wrap" style="overflow-x:auto;margin-top:12px">
        <table>
          <thead><tr>
            <th>Paciente</th><th>Leito</th><th>UTI</th><th>Previsão de Alta</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } else {
    tabelaHtml = `<div class="empty-state" style="padding:24px"><span class="empty-icon">📋</span><p style="color:var(--text-muted)">Nenhum paciente com previsão de alta registrada.</p></div>`;
  }

  return `
    <div class="section-title" style="margin-top:8px">🏥 Previsão de Alta da UTI</div>
    <div class="kpi-grid kpi-grid-3" style="margin-bottom:12px">${kpis}</div>
    <div class="card" style="padding:16px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <h3 style="margin:0;font-size:.95rem">Pacientes Internados — Previsão de Alta</h3>
        <span class="badge badge-primary">${totalComPrevisao} paciente${totalComPrevisao!==1?'s':''}</span>
        ${comAlta ? `<span class="badge badge-success">${comAlta} com previsão de alta</span>` : ''}
      </div>
      ${tabelaHtml}
    </div>`;
}

function kpiCard(label, value, unit, color='primary', sub='') {
  return `<div class="kpi-card ${color}">
    <div class="kpi-label">${escHtml(label)}</div>
    <div class="kpi-value">${escHtml(String(value))}</div>
    ${unit?`<div class="kpi-unit">${escHtml(unit)}</div>`:''}
    ${sub?`<div class="kpi-sub">${escHtml(sub)}</div>`:''}
  </div>`;
}

function drawTrendCharts(trends) {
  const labels = trends.map(t=>fmtDate(t.data_registro));
  const totals = trends.map(t=>t.total||1);
  const pcts   = key => trends.map((t,i)=>totals[i]?Math.round((t[key]||0)/totals[i]*100):0);

  const fillPcts = trends.map(t => {
    const ativos = t.ativos_no_dia || t.total || 1;
    return ativos ? Math.round((t.total||0) / ativos * 100) : 0;
  });
  const meta80 = labels.map(()=>80);
  drawLineChart('chart-preenchimento',
    ['Taxa de Preenchimento', 'Meta (80%)'],
    [fillPcts, meta80],
    ['#00897B', '#81C784'],
    labels,
    [{ borderWidth:2, pointRadius:3 }, { borderDash:[6,4], borderWidth:1.5, pointRadius:0, tension:0 }]);

  drawLineChart('chart-vm-atb',  ['VM Invasiva','Antibiótico'],     [pcts('vmi'),pcts('atb')],          ['#E65100','#C62828'], labels);
  drawLineChart('chart-del-mob', ['Delirium +','Mobilização'],      [pcts('delirium'),pcts('mobilizados')],['#FFA726','#2E7D32'], labels);
  drawLineChart('chart-vaso-dvc',['Vasopressor','Disp. Venoso'],    [pcts('vasopressor'),pcts('dvc')],  ['#C62828','#01579B'], labels);
  drawLineChart('chart-svd-tev', ['Sonda Vesical','Profilaxia TEV'],[pcts('svd'),pcts('prof_tev_ok')||trends.map(()=>0)],['#5C6BC0','#00897B'], labels);
}

function drawLineChart(id, seriesLabels, seriesData, colors, labels, dsOverrides) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  if (state.charts[id]) { state.charts[id].destroy(); }
  state.charts[id] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: seriesLabels.map((l,i)=>({
        label:l, data:seriesData[i],
        borderColor:colors[i], backgroundColor:colors[i]+'22',
        borderWidth:2, pointRadius:labels.length>20?0:3, tension:.3, fill:false,
        ...(dsOverrides && dsOverrides[i] ? dsOverrides[i] : {})
      }))
    },
    options: {
      responsive:true, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{position:'top',labels:{font:{size:11},boxWidth:12}},
        tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.y}%`}} },
      scales:{
        y:{min:0,max:100,ticks:{callback:v=>v+'%',font:{size:10}},grid:{color:'#ECEFF1'}},
        x:{ticks:{font:{size:10},maxRotation:45},grid:{display:false}}
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  ADMIN PAGE
// ═══════════════════════════════════════════════════════════

async function renderAdmin() {
  if (state.currentUser?.role !== 'admin') {
    navigate('home');
    return;
  }

  const main = document.getElementById('main-content');

  main.innerHTML = `
    <div class="admin-page">
      <div class="admin-tabs">
        <button class="admin-tab active" data-tab="users" onclick="switchAdminTab('users')">👥 Usuários</button>
        <button class="admin-tab" data-tab="data" onclick="switchAdminTab('data')">🗄️ Dados</button>
        <button class="admin-tab" data-tab="logs" onclick="switchAdminTab('logs')">📜 Logs</button>
      </div>
      <div id="admin-content">
        <div class="page-loader"><div class="spinner"></div></div>
      </div>
    </div>`;

  await loadAdminUsers();
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  if (tab === 'users') loadAdminUsers();
  else if (tab === 'data') loadAdminData();
  else if (tab === 'logs') loadAdminLogs();
}

// ─── Admin: Users ─────────────────────────────

async function loadAdminUsers() {
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="page-loader"><div class="spinner"></div></div>';

  try {
    const users = await api.get('/admin/users');

    if (!users.length) {
      content.innerHTML = '<div class="empty-state"><p>Nenhum usuário cadastrado.</p></div>';
      return;
    }

    const rows = users.map(u => {
      const isSelf = u.id === state.currentUser.id;
      const roleBadge = u.role === 'admin'
        ? '<span class="badge badge-primary">Admin</span>'
        : '<span class="badge badge-neutral">Usuário</span>';
      const toggleBtn = isSelf ? '' : `
        <button class="btn btn-sm btn-outline" onclick="adminToggleRole('${u.id}', '${u.role}')">
          ${u.role === 'admin' ? '⬇ Rebaixar' : '⬆ Promover'}
        </button>`;
      const deleteBtn = isSelf ? '' : `
        <button class="btn btn-sm btn-danger-outline" onclick="adminDeleteUser('${u.id}', '${escHtml(u.email)}')">
          🗑️
        </button>`;

      return `<tr>
        <td><strong>${escHtml(u.full_name || '—')}</strong></td>
        <td>${escHtml(u.email)}</td>
        <td>${fmtDateTime(u.created_at)}</td>
        <td>${u.last_sign_in_at ? fmtDateTime(u.last_sign_in_at) : '—'}</td>
        <td>${roleBadge}</td>
        <td style="white-space:nowrap">${toggleBtn} ${deleteBtn}</td>
      </tr>`;
    }).join('');

    content.innerHTML = `
      <div class="card" style="padding:16px">
        <h3 style="margin:0 0 12px">Gerenciamento de Usuários</h3>
        <div class="table-wrap" style="overflow-x:auto">
          <table>
            <thead><tr>
              <th>Nome</th><th>Email</th><th>Cadastro</th><th>Último Login</th><th>Permissão</th><th>Ações</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  } catch (err) {
    content.innerHTML = `<div style="padding:24px;color:var(--danger)">Erro: ${escHtml(err.message)}</div>`;
  }
}

async function adminToggleRole(userId, currentRole) {
  const newRole = currentRole === 'admin' ? 'user' : 'admin';
  const action = newRole === 'admin' ? 'promover a Administrador' : 'rebaixar a Usuário';

  if (!confirm(`Deseja ${action}?`)) return;

  try {
    await api.put(`/admin/users/${userId}/role`, { role: newRole });
    toast(`Permissão alterada para ${newRole}`, 'success');
    await loadAdminUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function adminDeleteUser(userId, email) {
  if (!confirm(`Excluir a conta de ${email}? Esta ação é irreversível.`)) return;
  if (!confirm(`CONFIRMAR: Tem certeza que deseja excluir ${email}?`)) return;

  try {
    await api.delete(`/admin/users/${userId}`);
    toast('Usuário excluído com sucesso', 'success');
    await loadAdminUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Admin: Data Management ──────────────────

async function loadAdminData() {
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="page-loader"><div class="spinner"></div></div>';

  try {
    const records = await api.get('/historico?data_inicio=2020-01-01&data_fim=2099-12-31');

    if (!records.length) {
      content.innerHTML = '<div class="empty-state"><p>Nenhum registro de ocupação encontrado.</p></div>';
      return;
    }

    const rows = records.map(r => {
      const motivoBadge = r.ativa
        ? '<span class="badge motivo-badge-ativa">Ativo</span>'
        : r.motivo_saida === 'alta'
          ? '<span class="badge motivo-badge-alta">Alta</span>'
          : '<span class="badge motivo-badge-obito">Óbito</span>';
      return `<tr>
        <td>${escHtml(r.uti_nome)}</td>
        <td style="text-align:center">${escHtml(r.leito_numero)}</td>
        <td><strong>${escHtml(r.nome_paciente)}</strong></td>
        <td>${fmtDateTime(r.data_entrada)}</td>
        <td>${motivoBadge}</td>
        <td>
          <button class="btn btn-sm btn-danger-outline" onclick="adminDeleteOcupacao(${r.id}, '${escHtml(r.nome_paciente)}')">
            🗑️ Excluir
          </button>
        </td>
      </tr>`;
    }).join('');

    content.innerHTML = `
      <div class="card" style="padding:16px">
        <h3 style="margin:0 0 12px">Gerenciamento de Dados (Ocupações)</h3>
        <p style="font-size:.82rem;color:var(--text-muted);margin-bottom:12px">
          ⚠ Excluir um registro remove também todos os checklists associados.
        </p>
        <div class="table-wrap" style="overflow-x:auto">
          <table>
            <thead><tr>
              <th>UTI</th><th>Leito</th><th>Paciente</th><th>Entrada</th><th>Status</th><th>Ação</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  } catch (err) {
    content.innerHTML = `<div style="padding:24px;color:var(--danger)">Erro: ${escHtml(err.message)}</div>`;
  }
}

async function adminDeleteOcupacao(id, nome) {
  if (!confirm(`Excluir o registro de ${nome}? Isso também excluirá os checklists associados.`)) return;

  try {
    await api.delete(`/admin/ocupacoes/${id}`);
    toast('Registro excluído', 'success');
    await loadAdminData();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Admin: Activity Logs ────────────────────

async function loadAdminLogs() {
  const content = document.getElementById('admin-content');
  content.innerHTML = '<div class="page-loader"><div class="spinner"></div></div>';

  try {
    const logs = await api.get('/admin/logs');

    if (!logs.length) {
      content.innerHTML = '<div class="empty-state"><p>Nenhum log registrado.</p></div>';
      return;
    }

    const actionLabels = {
      account_created: '🟢 Conta criada',
      account_deleted: '🔴 Conta excluída',
      account_deleted_by_admin: '🔴 Conta excluída (admin)',
      role_changed: '🔄 Permissão alterada',
      login: '🔑 Login'
    };

    const rows = logs.map(l => {
      const details = l.details || {};
      let detailStr = '';
      if (l.action === 'role_changed') {
        detailStr = `${details.old_role || '?'} → ${details.new_role || '?'}`;
      } else if (details.method) {
        detailStr = details.method;
      }

      return `<tr>
        <td>${actionLabels[l.action] || l.action}</td>
        <td>${escHtml(l.target_email || '—')}</td>
        <td>${fmtDateTime(l.created_at)}</td>
        <td>${escHtml(l.performed_email || 'sistema')}</td>
        <td style="font-size:.8rem;color:var(--text-muted)">${escHtml(detailStr)}</td>
      </tr>`;
    }).join('');

    content.innerHTML = `
      <div class="card" style="padding:16px">
        <h3 style="margin:0 0 12px">Logs de Atividades</h3>
        <div class="table-wrap" style="overflow-x:auto">
          <table>
            <thead><tr>
              <th>Ação</th><th>Usuário Afetado</th><th>Data/Hora</th><th>Executado por</th><th>Detalhes</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  } catch (err) {
    content.innerHTML = `<div style="padding:24px;color:var(--danger)">Erro: ${escHtml(err.message)}</div>`;
  }
}

// ─────────────────────────────────────────────
//  SIDEBAR DATE
// ─────────────────────────────────────────────

function updateSidebarDate() {
  const el = document.getElementById('sidebar-date');
  if (el) el.textContent = new Date().toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
}

// ─────────────────────────────────────────────
//  INIT — Supabase Auth
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Modal handlers
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target===e.currentTarget) closeModal();
  });
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  document.querySelectorAll('.nav-item').forEach(a => {
    a.addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));
  });

  // User menu dropdown
  const userMenuBtn = document.getElementById('user-menu-btn');
  const userDropdown = document.getElementById('user-dropdown');
  if (userMenuBtn && userDropdown) {
    userMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      userDropdown.hidden = !userDropdown.hidden;
    });
    document.addEventListener('click', () => { userDropdown.hidden = true; });
  }

  // Logout
  document.getElementById('btn-logout')?.addEventListener('click', doLogout);

  // Auth form events
  document.getElementById('login-form')?.addEventListener('submit', doLogin);
  document.getElementById('register-form')?.addEventListener('submit', doRegister);
  document.getElementById('forgot-form')?.addEventListener('submit', doForgotPassword);
  document.getElementById('reset-form')?.addEventListener('submit', doResetPassword);

  // Auth form navigation
  document.getElementById('show-register')?.addEventListener('click', e => { e.preventDefault(); showRegisterForm(); });
  document.getElementById('show-forgot')?.addEventListener('click', e => { e.preventDefault(); showForgotForm(); });
  document.getElementById('show-login-from-reg')?.addEventListener('click', e => { e.preventDefault(); showLoginForm(); });
  document.getElementById('show-login-from-forgot')?.addEventListener('click', e => { e.preventDefault(); showLoginForm(); });

  updateSidebarDate();

  // Initialize Supabase
  const sbReady = await initSupabase();

  if (!sbReady) {
    // Supabase not configured — show error
    document.getElementById('auth-screen').hidden = false;
    document.getElementById('app-shell').hidden = true;
    const container = document.querySelector('.auth-container');
    if (container) {
      container.innerHTML = `
        <div class="auth-brand">
          <h1>Monitor <strong>NEXO</strong></h1>
        </div>
        <div class="auth-form">
          <div class="auth-error" style="display:block">
            Supabase não configurado. Defina as variáveis de ambiente:<br/>
            <code>SUPABASE_URL</code>, <code>SUPABASE_ANON_KEY</code>, <code>SUPABASE_SERVICE_ROLE_KEY</code>
          </div>
        </div>`;
    }
    return;
  }

  // Check for password reset flow (hash contains access_token)
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  if (hashParams.get('type') === 'recovery' || window.location.hash.includes('type=recovery')) {
    showResetForm();
    return;
  }

  // Check existing session
  const hasSession = await checkSession();

  if (hasSession) {
    showApp();
    window.addEventListener('hashchange', handleRoute);
    if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#login') {
      window.location.hash = 'home';
    } else {
      handleRoute();
    }
  } else {
    showAuthScreen();
  }
});

// Global onclick handlers
window.navigate             = navigate;
window.openBedModal         = openBedModal;
window.showAdmitForm        = showAdmitForm;
window.showDischargeStep1   = showDischargeStep1;
window.selectMotivo         = selectMotivo;
window.showDischargeConfirm = showDischargeConfirm;
window.executeDischarge     = executeDischarge;
window.goChecklistFromBed   = goChecklistFromBed;
window.closeModal           = closeModal;
window.switchAdminTab       = switchAdminTab;
window.adminToggleRole      = adminToggleRole;
window.adminDeleteUser      = adminDeleteUser;
window.adminDeleteOcupacao  = adminDeleteOcupacao;
