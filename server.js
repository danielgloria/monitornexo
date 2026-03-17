/**
 * Monitor NEXO — Backend Node.js / Express
 * Plataforma de Monitoramento Assistencial
 *
 * All 17 API routes + email approval page + SPA catch-all
 */

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const session = require('express-session');
const bcrypt  = require('bcryptjs');

const { db, initDb } = require('./database');

// ─── Initialize DB ────────────────────────────
initDb();

// ─── App setup ────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Email config ─────────────────────────────
const SMTP_HOST   = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT   = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER   = process.env.SMTP_USER || '';
const SMTP_PASS   = process.env.SMTP_PASS || '';
const ADMIN_EMAIL = 'danielvgloria@gmail.com';
const APP_URL     = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

// ─── Custom SQLite Session Store ──────────────
class SQLiteStore extends session.Store {
  constructor() {
    super();
    this._gc();
  }

  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > datetime(\'now\')').get(sid);
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || 43200000; // 12h default
      const expired = new Date(Date.now() + maxAge).toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(
        'INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)'
      ).run(sid, JSON.stringify(sess), expired);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  _gc() {
    try { db.prepare("DELETE FROM sessions WHERE expired <= datetime('now')").run(); } catch (_) {}
    setTimeout(() => this._gc(), 3600000); // every hour
  }
}

// ─── Session middleware ───────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const IS_PROD = process.env.NODE_ENV === 'production';

// Trust proxy in production (Render uses reverse proxy)
if (IS_PROD) app.set('trust proxy', 1);

app.use(session({
  store: new SQLiteStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,  // HTTPS only in production
  },
}));

// ─────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────

function loginRequired(req, res, next) {
  const uid = req.session.user_id;
  if (!uid) return res.status(401).json({ error: 'Autenticacao necessaria', auth_required: true });

  const user = db.prepare('SELECT id, perfil, status FROM usuarios WHERE id = ?').get(uid);
  if (!user || user.status !== 'aprovado') {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'Acesso negado', auth_required: true });
  }
  req.currentUser = user;
  next();
}

function adminRequired(req, res, next) {
  const uid = req.session.user_id;
  if (!uid) return res.status(401).json({ error: 'Autenticacao necessaria', auth_required: true });

  const user = db.prepare('SELECT id, perfil, status FROM usuarios WHERE id = ?').get(uid);
  if (!user || user.status !== 'aprovado' || user.perfil !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  }
  req.currentUser = user;
  next();
}

// ─────────────────────────────────────────────
//  EMAIL SERVICE
// ─────────────────────────────────────────────

async function sendEmailAsync(to, subject, html) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.log(`[EMAIL] SMTP nao configurado. Email para ${to} nao enviado.`);
    console.log(`[EMAIL] Assunto: ${subject}`);
    return;
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transporter.sendMail({
      from: `"Monitor NEXO" <${SMTP_USER}>`,
      to, subject, html,
    });
    console.log(`[EMAIL] Enviado para ${to}`);
  } catch (e) {
    console.log(`[EMAIL] Erro ao enviar para ${to}: ${e.message}`);
  }
}

function sendApprovalEmail(userNome, userEmail, userId) {
  const approveToken = crypto.randomBytes(36).toString('base64url');
  const rejectToken  = crypto.randomBytes(36).toString('base64url');
  const expira = new Date(Date.now() + 7 * 24 * 3600000).toISOString().replace('T', ' ').slice(0, 19);

  db.prepare('INSERT INTO tokens_aprovacao (usuario_id, token, acao, expira_em) VALUES (?,?,?,?)')
    .run(userId, approveToken, 'aprovar', expira);
  db.prepare('INSERT INTO tokens_aprovacao (usuario_id, token, acao, expira_em) VALUES (?,?,?,?)')
    .run(userId, rejectToken, 'recusar', expira);

  const approveUrl = `${APP_URL}/auth/aprovar/${approveToken}`;
  const rejectUrl  = `${APP_URL}/auth/aprovar/${rejectToken}`;
  const dataStr = new Date().toLocaleString('pt-BR');

  const html = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f5f7fa;padding:30px">
    <div style="background:#1E3A8A;color:#fff;padding:24px 30px;border-radius:12px 12px 0 0;text-align:center">
      <h1 style="margin:0;font-size:22px;font-weight:800">Monitor NEXO</h1>
      <p style="margin:4px 0 0;font-size:13px;opacity:.8">Plataforma de Monitoramento Assistencial</p>
    </div>
    <div style="background:#fff;padding:28px 30px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;border-top:none">
      <h2 style="color:#1E3A8A;font-size:18px;margin:0 0 16px">Novo cadastro pendente</h2>
      <table style="width:100%;font-size:14px;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#64748b;width:130px">Nome:</td><td style="padding:8px 0;font-weight:600">${userNome}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b">Email:</td><td style="padding:8px 0;font-weight:600">${userEmail}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b">Data:</td><td style="padding:8px 0;font-weight:600">${dataStr}</td></tr>
      </table>
      <div style="margin:24px 0;text-align:center">
        <a href="${approveUrl}" style="display:inline-block;background:#16A34A;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin-right:12px">Aprovar conta</a>
        <a href="${rejectUrl}" style="display:inline-block;background:#DC2626;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Recusar</a>
      </div>
      <p style="font-size:12px;color:#94a3b8;text-align:center;margin:16px 0 0">Links validos por 7 dias.</p>
    </div>
  </div>`;

  sendEmailAsync(ADMIN_EMAIL, `[Monitor NEXO] Novo cadastro: ${userNome}`, html);
}

// ─────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const senha = req.body.senha || '';

  if (!email || !senha) {
    return res.status(400).json({ error: 'Email e senha sao obrigatorios' });
  }

  const user = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(senha, user.senha_hash)) {
    return res.status(401).json({ error: 'Usuario ou senha invalidos.' });
  }

  if (user.status === 'pendente') {
    return res.status(403).json({ error: 'Sua conta ainda esta aguardando aprovacao do administrador.' });
  }
  if (user.status === 'recusado') {
    return res.status(403).json({ error: 'Sua conta foi recusada pelo administrador.' });
  }

  req.session.user_id = user.id;
  res.json({
    user: { id: user.id, nome: user.nome, email: user.email, perfil: user.perfil }
  });
});

// POST /api/auth/register
app.post('/api/auth/register', (req, res) => {
  const nome  = (req.body.nome || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const senha = req.body.senha || '';

  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Todos os campos sao obrigatorios' });
  }
  if (nome.length < 3) {
    return res.status(400).json({ error: 'Nome deve ter pelo menos 3 caracteres' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Formato de email invalido' });
  }
  if (senha.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  }

  const existing = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Ja existe uma conta com este email' });
  }

  const hash = bcrypt.hashSync(senha, 10);
  const result = db.prepare(
    'INSERT INTO usuarios (nome, email, senha_hash, perfil, status) VALUES (?,?,?,?,?)'
  ).run(nome, email, hash, 'usuario', 'pendente');

  sendApprovalEmail(nome, email, Number(result.lastInsertRowid));

  res.json({ message: 'Cadastro enviado com sucesso. Sua conta sera liberada apos aprovacao do administrador.' });
});

// GET /api/auth/me
app.get('/api/auth/me', (req, res) => {
  const uid = req.session.user_id;
  if (!uid) return res.json({ user: null });

  const user = db.prepare('SELECT id, nome, email, perfil, status FROM usuarios WHERE id = ?').get(uid);
  if (!user || user.status !== 'aprovado') {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }

  res.json({ user: { id: user.id, nome: user.nome, email: user.email, perfil: user.perfil } });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ message: 'Logout realizado' });
});

// ─── Email approval link handler ────────────
app.get('/auth/aprovar/:token', (req, res) => {
  const tk = db.prepare('SELECT * FROM tokens_aprovacao WHERE token = ? AND usado = 0').get(req.params.token);

  if (!tk) return res.send(approvalPage('Link invalido ou ja utilizado.', 'error'));

  const expiry = new Date(tk.expira_em.replace(' ', 'T') + 'Z');
  if (new Date() > expiry) return res.send(approvalPage('Este link expirou.', 'error'));

  const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(tk.usuario_id);
  if (!user) return res.send(approvalPage('Usuario nao encontrado.', 'error'));

  const newStatus = tk.acao === 'aprovar' ? 'aprovado' : 'recusado';
  db.prepare('UPDATE usuarios SET status = ? WHERE id = ?').run(newStatus, tk.usuario_id);
  db.prepare('UPDATE tokens_aprovacao SET usado = 1 WHERE usuario_id = ?').run(tk.usuario_id);

  if (tk.acao === 'aprovar') {
    res.send(approvalPage(`Conta de <strong>${user.nome}</strong> (${user.email}) aprovada com sucesso.`, 'success'));
  } else {
    res.send(approvalPage(`Conta de <strong>${user.nome}</strong> (${user.email}) foi recusada.`, 'warning'));
  }
});

function approvalPage(message, status) {
  const colors = { success: '#16A34A', error: '#DC2626', warning: '#D97706' };
  const icons  = { success: '&#x2713;', error: '&#x2717;', warning: '&#x26A0;' };
  const color  = colors[status] || '#64748B';
  const icon   = icons[status] || '';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitor NEXO</title>
<style>
  body { font-family:'Inter','Segoe UI',sans-serif; background:#F5F7FA; display:flex;
         align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { background:#fff; border-radius:16px; padding:48px 40px; text-align:center;
           max-width:440px; box-shadow:0 4px 16px rgba(15,23,42,.08); }
  .icon { font-size:48px; color:${color}; margin-bottom:16px; display:block; }
  h2 { color:#0F172A; font-size:1.2rem; margin:0 0 12px; }
  p { color:#64748B; font-size:.9rem; line-height:1.6; margin:0; }
  a { display:inline-block; margin-top:24px; padding:10px 28px; background:#1E3A8A;
       color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:.875rem; }
  a:hover { background:#3B82F6; }
</style></head><body>
<div class="card">
  <span class="icon">${icon}</span>
  <h2>Monitor NEXO</h2>
  <p>${message}</p>
  <a href="/">Ir para o sistema</a>
</div></body></html>`;
}

// ─────────────────────────────────────────────
//  ADMIN — USER MANAGEMENT
// ─────────────────────────────────────────────

// GET /api/admin/usuarios
app.get('/api/admin/usuarios', adminRequired, (req, res) => {
  let sql = 'SELECT id, nome, email, perfil, status, created_at FROM usuarios WHERE 1=1';
  const params = [];
  if (req.query.status) {
    sql += ' AND status = ?';
    params.push(req.query.status);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// POST /api/admin/usuarios/:id/aprovar
app.post('/api/admin/usuarios/:id/aprovar', adminRequired, (req, res) => {
  const uid = Number(req.params.id);
  const user = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(uid);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
  db.prepare('UPDATE usuarios SET status = ? WHERE id = ?').run('aprovado', uid);
  res.json({ message: 'Usuario aprovado com sucesso' });
});

// POST /api/admin/usuarios/:id/recusar
app.post('/api/admin/usuarios/:id/recusar', adminRequired, (req, res) => {
  const uid = Number(req.params.id);
  const user = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(uid);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
  db.prepare('UPDATE usuarios SET status = ? WHERE id = ?').run('recusado', uid);
  res.json({ message: 'Usuario recusado' });
});

// DELETE /api/admin/usuarios/:id
app.delete('/api/admin/usuarios/:id', adminRequired, (req, res) => {
  const uid = Number(req.params.id);
  if (uid === req.session.user_id) {
    return res.status(400).json({ error: 'Voce nao pode excluir sua propria conta' });
  }
  db.prepare('DELETE FROM tokens_aprovacao WHERE usuario_id = ?').run(uid);
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(uid);
  res.json({ message: 'Usuario excluido' });
});

// ─────────────────────────────────────────────
//  UTIs
// ─────────────────────────────────────────────

// GET /api/utis
app.get('/api/utis', loginRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.nome,
      COUNT(l.id)                                          AS total_leitos,
      SUM(CASE WHEN o.ativa = 1 THEN 1 ELSE 0 END)        AS ocupados,
      COUNT(l.id) - SUM(CASE WHEN o.ativa = 1 THEN 1 ELSE 0 END) AS vagos
    FROM utis u
    JOIN leitos l ON l.uti_id = u.id AND l.ativo = 1
    LEFT JOIN ocupacoes o ON o.leito_id = l.id AND o.ativa = 1
    WHERE u.ativo = 1
    GROUP BY u.id, u.nome ORDER BY u.id
  `).all();
  res.json(rows);
});

// ─────────────────────────────────────────────
//  LEITOS
// ─────────────────────────────────────────────

// GET /api/utis/:id/leitos
app.get('/api/utis/:id/leitos', loginRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT
      l.id, l.numero, l.uti_id,
      o.id             AS ocupacao_id,
      o.nome_paciente,
      o.data_nascimento,
      o.data_entrada,
      CASE WHEN o.id IS NOT NULL THEN 1 ELSE 0 END AS ocupado
    FROM leitos l
    LEFT JOIN ocupacoes o ON o.leito_id = l.id AND o.ativa = 1
    WHERE l.uti_id = ? AND l.ativo = 1
    ORDER BY CAST(l.numero AS INTEGER)
  `).all(Number(req.params.id));
  res.json(rows);
});

// ─────────────────────────────────────────────
//  OCUPACOES
// ─────────────────────────────────────────────

// POST /api/leitos/:id/internar
app.post('/api/leitos/:id/internar', loginRequired, (req, res) => {
  const leitoId = Number(req.params.id);
  const nome = (req.body.nome_paciente || '').trim();
  const dob  = req.body.data_nascimento;

  if (!nome || !dob) {
    return res.status(400).json({ error: 'Nome e data de nascimento sao obrigatorios' });
  }

  const occupied = db.prepare('SELECT id FROM ocupacoes WHERE leito_id = ? AND ativa = 1').get(leitoId);
  if (occupied) {
    return res.status(409).json({ error: 'Leito ocupado. Registre a saida primeiro.' });
  }

  const result = db.prepare(
    'INSERT INTO ocupacoes (leito_id, nome_paciente, data_nascimento) VALUES (?, ?, ?)'
  ).run(leitoId, nome, dob);

  res.json({ id: Number(result.lastInsertRowid), message: 'Paciente internado com sucesso' });
});

// POST /api/ocupacoes/:id/saida
app.post('/api/ocupacoes/:id/saida', loginRequired, (req, res) => {
  const oid    = Number(req.params.id);
  const motivo = req.body.motivo_saida;

  if (!['alta', 'obito'].includes(motivo)) {
    return res.status(400).json({ error: 'Motivo deve ser "alta" ou "obito"' });
  }

  const occ = db.prepare('SELECT id, ativa FROM ocupacoes WHERE id = ?').get(oid);
  if (!occ) return res.status(404).json({ error: 'Ocupacao nao encontrada' });
  if (!occ.ativa) return res.status(400).json({ error: 'Ocupacao ja encerrada' });

  db.prepare(
    "UPDATE ocupacoes SET ativa = 0, data_saida = datetime('now','localtime'), motivo_saida = ? WHERE id = ?"
  ).run(motivo, oid);

  res.json({ message: 'Saida registrada com sucesso' });
});

// GET /api/historico
app.get('/api/historico', loginRequired, (req, res) => {
  let sql = `
    SELECT o.id, o.nome_paciente, o.data_nascimento,
      o.data_entrada, o.data_saida, o.motivo_saida, o.ativa,
      l.numero AS leito_numero, l.id AS leito_id,
      u.nome AS uti_nome, u.id AS uti_id
    FROM ocupacoes o
    JOIN leitos l ON l.id = o.leito_id
    JOIN utis u ON u.id = l.uti_id
    WHERE 1=1
  `;
  const params = [];

  if (req.query.uti_id)       { sql += ' AND u.id = ?';                   params.push(Number(req.query.uti_id)); }
  if (req.query.leito_numero) { sql += ' AND l.numero = ?';               params.push(req.query.leito_numero); }
  if (req.query.data_inicio)  { sql += ' AND date(o.data_entrada) >= ?';  params.push(req.query.data_inicio); }
  if (req.query.data_fim)     { sql += ' AND date(o.data_entrada) <= ?';  params.push(req.query.data_fim); }
  if (req.query.motivo_saida) { sql += ' AND o.motivo_saida = ?';         params.push(req.query.motivo_saida); }

  sql += ' ORDER BY o.data_entrada DESC';
  res.json(db.prepare(sql).all(...params));
});

// ─────────────────────────────────────────────
//  CHECKLISTS
// ─────────────────────────────────────────────

// GET /api/checklists/ocupacao/:id/data/:data
app.get('/api/checklists/ocupacao/:id/data/:data', loginRequired, (req, res) => {
  const row = db.prepare(
    'SELECT * FROM checklists WHERE ocupacao_id = ? AND data_registro = ?'
  ).get(Number(req.params.id), req.params.data);
  res.json(row || null);
});

// POST /api/checklists
app.post('/api/checklists', loginRequired, (req, res) => {
  const d    = req.body;
  const oid  = d.ocupacao_id;
  const lid  = d.leito_id;
  const dr   = d.data_registro;
  const prof = (d.profissional || '').trim();

  if (!oid || !lid || !dr || !prof) {
    return res.status(400).json({ error: 'Campos obrigatorios faltando' });
  }

  const occ = db.prepare('SELECT id FROM ocupacoes WHERE id = ?').get(oid);
  if (!occ) return res.status(404).json({ error: 'Internacao nao encontrada' });

  const fields = {
    antibiotico:              d.antibiotico,
    dia_antibiotico:          d.dia_antibiotico || null,
    ventilacao:               d.ventilacao,
    dia_ventilacao:           d.dia_ventilacao || null,
    dispositivo_venoso:       d.dispositivo_venoso,
    sonda_vesical:            d.sonda_vesical,
    nutricao:                 d.nutricao,
    vasopressor:              d.vasopressor,
    sedacao:                  d.sedacao,
    delirium:                 d.delirium,
    profilaxia_tev:           d.profilaxia_tev,
    profilaxia_ue:            d.profilaxia_ue,
    mobilizacao:              d.mobilizacao,
    dispositivos_necessarios: d.dispositivos_necessarios,
    reavaliacao_atb:          d.reavaliacao_atb || null,
    dias_vm:                  d.dias_vm || null,
    dias_cvc:                 d.dias_cvc || null,
    dias_sonda:               d.dias_sonda || null,
    previsao_alta:            d.previsao_alta || null,
    profissional:             prof,
  };

  const existing = db.prepare(
    'SELECT id FROM checklists WHERE ocupacao_id = ? AND data_registro = ?'
  ).get(oid, dr);

  if (existing) {
    const setClauses = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE checklists SET ${setClauses} WHERE id = @_id`).run({ ...fields, _id: existing.id });
    res.json({ id: existing.id, message: 'Checklist atualizado' });
  } else {
    const cols = ['ocupacao_id', 'leito_id', 'data_registro', ...Object.keys(fields)];
    const placeholders = cols.map(c => `@${c}`).join(', ');
    const result = db.prepare(
      `INSERT INTO checklists (${cols.join(', ')}) VALUES (${placeholders})`
    ).run({ ocupacao_id: oid, leito_id: lid, data_registro: dr, ...fields });
    res.json({ id: Number(result.lastInsertRowid), message: 'Checklist salvo' });
  }
});

// ─────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────

app.get('/api/dashboard', loginRequired, (req, res) => {
  const hoje = new Date().toISOString().split('T')[0];
  const utiId = req.query.uti_id;
  const defaultInicio = new Date(Date.now() - 29 * 86400000).toISOString().split('T')[0];
  const inicio = req.query.data_inicio || defaultInicio;
  const fim    = req.query.data_fim || hoje;

  const uf = utiId ? ' AND l.uti_id = ?' : '';
  const up = utiId ? [Number(utiId)] : [];

  // occ_stats — occupancy by UTI
  const occ_stats = db.prepare(`
    SELECT u.id, u.nome,
      COUNT(l.id) AS total,
      SUM(CASE WHEN o.ativa = 1 THEN 1 ELSE 0 END) AS ocupados,
      COUNT(l.id) - SUM(CASE WHEN o.ativa = 1 THEN 1 ELSE 0 END) AS vagos
    FROM utis u
    JOIN leitos l ON l.uti_id = u.id AND l.ativo = 1
    LEFT JOIN ocupacoes o ON o.leito_id = l.id AND o.ativa = 1
    WHERE u.ativo = 1 GROUP BY u.id ORDER BY u.id
  `).all();

  // totalPacientes
  const totalPacientes = db.prepare(
    `SELECT COUNT(*) AS n FROM ocupacoes o JOIN leitos l ON l.id = o.leito_id WHERE o.ativa = 1${uf}`
  ).get(...up).n;

  // hoje_stats — aggregated checklist stats for period
  const hs = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN ventilacao = 'vmi' THEN 1 ELSE 0 END)  AS ventilados_vmi,
      SUM(CASE WHEN antibiotico = 'sim' THEN 1 ELSE 0 END)  AS uso_atb,
      SUM(CASE WHEN dispositivo_venoso IN ('cvc','picc') THEN 1 ELSE 0 END) AS uso_dvc,
      SUM(CASE WHEN sonda_vesical = 'sim' THEN 1 ELSE 0 END) AS uso_svd,
      SUM(CASE WHEN vasopressor = 'sim' THEN 1 ELSE 0 END)   AS uso_vaso,
      SUM(CASE WHEN delirium = 'positivo' THEN 1 ELSE 0 END) AS delirium_pos,
      SUM(CASE WHEN mobilizacao IN ('sedestacao','ortostatismo','deambulacao') THEN 1 ELSE 0 END) AS mobilizados,
      SUM(CASE WHEN profilaxia_tev IN ('farmacologica','mecanica') THEN 1 ELSE 0 END) AS prof_tev_ok,
      AVG(CASE WHEN ventilacao = 'vmi' AND dia_ventilacao IS NOT NULL THEN CAST(dia_ventilacao AS REAL) END) AS media_dias_vm,
      AVG(CASE WHEN antibiotico = 'sim' AND dia_antibiotico IS NOT NULL THEN CAST(dia_antibiotico AS REAL) END) AS media_dias_atb
    FROM checklists c JOIN leitos l ON l.id = c.leito_id
    WHERE c.data_registro BETWEEN ? AND ?${uf}
  `).get(inicio, fim, ...up);

  const hoje_stats = hs || {};

  // checklist_count_hoje
  const checklist_count_hoje = db.prepare(
    `SELECT COUNT(*) AS n FROM checklists c JOIN leitos l ON l.id = c.leito_id WHERE c.data_registro = ?${uf}`
  ).get(hoje, ...up).n;

  // avg_los
  const avgRow = db.prepare(`
    SELECT AVG(CAST(
      COALESCE(julianday(o.data_saida), julianday('now')) - julianday(o.data_entrada)
    AS REAL)) AS v
    FROM ocupacoes o JOIN leitos l ON l.id = o.leito_id
    WHERE date(o.data_entrada) BETWEEN ? AND ?${uf}
  `).get(inicio, fim, ...up);
  const avg_los = avgRow && avgRow.v ? Math.round(avgRow.v * 10) / 10 : 0;

  // trends
  const uf2 = utiId ? ` AND l2.uti_id = ${Number(utiId)}` : '';
  const trends = db.prepare(`
    SELECT c.data_registro,
      COUNT(*) AS total,
      SUM(CASE WHEN ventilacao = 'vmi' THEN 1 ELSE 0 END) AS vmi,
      SUM(CASE WHEN antibiotico = 'sim' THEN 1 ELSE 0 END) AS atb,
      SUM(CASE WHEN delirium = 'positivo' THEN 1 ELSE 0 END) AS delirium,
      SUM(CASE WHEN mobilizacao IN ('sedestacao','ortostatismo','deambulacao') THEN 1 ELSE 0 END) AS mobilizados,
      SUM(CASE WHEN vasopressor = 'sim' THEN 1 ELSE 0 END) AS vasopressor,
      SUM(CASE WHEN sonda_vesical = 'sim' THEN 1 ELSE 0 END) AS svd,
      SUM(CASE WHEN dispositivo_venoso IN ('cvc','picc') THEN 1 ELSE 0 END) AS dvc,
      (SELECT COUNT(*) FROM ocupacoes o2
       JOIN leitos l2 ON l2.id = o2.leito_id
       WHERE date(o2.data_entrada) <= c.data_registro
       AND (o2.data_saida IS NULL OR date(o2.data_saida) >= c.data_registro)${uf2}
      ) AS ativos_no_dia
    FROM checklists c JOIN leitos l ON l.id = c.leito_id
    WHERE c.data_registro BETWEEN ? AND ?${uf}
    GROUP BY c.data_registro ORDER BY c.data_registro
  `).all(inicio, fim, ...up);

  res.json({
    totalPacientes,
    checklist_count_hoje,
    checklist_count_periodo: hoje_stats.total || 0,
    hoje_stats,
    avg_los,
    trends,
    occ_stats,
    periodo: { inicio, fim },
  });
});

// ─────────────────────────────────────────────
//  EXPORT CSV
// ─────────────────────────────────────────────

app.get('/api/export/csv', loginRequired, (req, res) => {
  let sql = `
    SELECT u.nome AS uti, l.numero AS leito,
      o.nome_paciente, o.data_nascimento,
      c.data_registro,
      c.antibiotico, c.dia_antibiotico, c.ventilacao, c.dia_ventilacao,
      c.dispositivo_venoso, c.sonda_vesical, c.nutricao,
      c.vasopressor, c.sedacao, c.delirium,
      c.profilaxia_tev, c.profilaxia_ue, c.mobilizacao,
      c.dispositivos_necessarios,
      c.reavaliacao_atb, c.dias_vm, c.dias_cvc, c.dias_sonda,
      c.previsao_alta, c.profissional
    FROM checklists c
    JOIN ocupacoes o ON o.id = c.ocupacao_id
    JOIN leitos l ON l.id = c.leito_id
    JOIN utis u ON u.id = l.uti_id WHERE 1=1
  `;
  const params = [];
  if (req.query.uti_id)      { sql += ' AND u.id = ?';            params.push(Number(req.query.uti_id)); }
  if (req.query.data_inicio) { sql += ' AND c.data_registro >= ?'; params.push(req.query.data_inicio); }
  if (req.query.data_fim)    { sql += ' AND c.data_registro <= ?'; params.push(req.query.data_fim); }
  sql += ' ORDER BY c.data_registro DESC, u.id, CAST(l.numero AS INTEGER)';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return res.status(404).json({ error: 'Nenhum dado encontrado' });

  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(';'),
    ...rows.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(';'))
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="UTI_checklists.csv"');
  res.send('\uFEFF' + csvLines.join('\r\n'));
});

// ─────────────────────────────────────────────
//  SPA CATCH-ALL
// ─────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n[OK] Monitor NEXO rodando em http://localhost:${PORT}\n`);
});
