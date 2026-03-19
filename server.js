/**
 * Monitor NEXO — Backend Node.js / Express
 * Plataforma de Monitoramento Assistencial v4.0
 *
 * API routes: UTIs, leitos, ocupacoes, checklists, dashboard, export CSV
 * Auth: Supabase (JWT verification + admin panel)
 * DB: sqlite3 (async) for clinical data
 */

const express = require('express');
const path    = require('path');

const { dbRun, dbGet, dbAll, initDb } = require('./database');
const { getSupabase, getSupabaseAdmin, requireAuth, requireAdmin, SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabase');

// ─── App setup ────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  SUPABASE CONFIG (public, used by frontend)
// ─────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  });
});

// ─────────────────────────────────────────────
//  AUTH: Profile & Session Info
// ─────────────────────────────────────────────

// GET /api/auth/me — retorna perfil do usuário logado
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase não configurado' });
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) {
      return res.json({
        id: req.user.id,
        email: req.user.email,
        full_name: '',
        role: 'user'
      });
    }

    res.json({
      id: req.user.id,
      email: req.user.email,
      full_name: profile.full_name || '',
      role: profile.role || 'user',
      created_at: profile.created_at
    });
  } catch (e) {
    console.error('[AUTH_ME]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─────────────────────────────────────────────
//  ADMIN: User Management
// ─────────────────────────────────────────────

// GET /api/admin/users — lista todos os usuários
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) return res.status(500).json({ error: 'Service role não configurado' });

    // Buscar users do auth
    const { data: { users }, error: authErr } = await supabaseAdmin.auth.admin.listUsers();
    if (authErr) throw authErr;

    // Buscar profiles
    const { data: profiles, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('*');

    const profileMap = {};
    if (profiles) profiles.forEach(p => { profileMap[p.id] = p; });

    const result = users.map(u => ({
      id: u.id,
      email: u.email,
      full_name: profileMap[u.id]?.full_name || '',
      role: profileMap[u.id]?.role || 'user',
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at
    }));

    res.json(result);
  } catch (e) {
    console.error('[ADMIN_USERS]', e);
    res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

// PUT /api/admin/users/:id/role — alterar role
app.put('/api/admin/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) return res.status(500).json({ error: 'Service role não configurado' });

    const targetId = req.params.id;
    const newRole = req.body.role;

    if (!['admin', 'user'].includes(newRole)) {
      return res.status(400).json({ error: 'Role inválida. Use "admin" ou "user".' });
    }

    // Não permitir rebaixar a si mesmo
    if (targetId === req.user.id && newRole === 'user') {
      return res.status(400).json({ error: 'Você não pode remover seus próprios privilégios de admin.' });
    }

    // Buscar role atual
    const { data: oldProfile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', targetId)
      .single();

    const oldRole = oldProfile?.role || 'user';

    // Atualizar
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ role: newRole, updated_at: new Date().toISOString() })
      .eq('id', targetId);

    if (error) throw error;

    // Buscar email do target
    const { data: { user: targetUser } } = await supabaseAdmin.auth.admin.getUserById(targetId);

    // Log
    await supabaseAdmin.from('activity_logs').insert({
      action: 'role_changed',
      target_user_id: targetId,
      target_email: targetUser?.email || '',
      performed_by: req.user.id,
      performed_email: req.user.email,
      details: { old_role: oldRole, new_role: newRole }
    });

    res.json({ message: `Permissão alterada para ${newRole}` });
  } catch (e) {
    console.error('[ADMIN_ROLE]', e);
    res.status(500).json({ error: 'Erro ao alterar permissão' });
  }
});

// DELETE /api/admin/users/:id — deletar usuário
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) return res.status(500).json({ error: 'Service role não configurado' });

    const targetId = req.params.id;

    // Não permitir deletar a si mesmo
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Você não pode excluir sua própria conta.' });
    }

    // Buscar email antes de deletar
    const { data: { user: targetUser } } = await supabaseAdmin.auth.admin.getUserById(targetId);

    // Log antes de deletar (o trigger on_auth_user_deleted também loga)
    await supabaseAdmin.from('activity_logs').insert({
      action: 'account_deleted_by_admin',
      target_user_id: targetId,
      target_email: targetUser?.email || '',
      performed_by: req.user.id,
      performed_email: req.user.email,
      details: { method: 'admin_panel' }
    });

    // Deletar do auth (cascade deleta o profile)
    const { error } = await supabaseAdmin.auth.admin.deleteUser(targetId);
    if (error) throw error;

    res.json({ message: 'Usuário excluído com sucesso' });
  } catch (e) {
    console.error('[ADMIN_DELETE]', e);
    res.status(500).json({ error: 'Erro ao excluir usuário' });
  }
});

// GET /api/admin/logs — logs de atividade
app.get('/api/admin/logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) return res.status(500).json({ error: 'Service role não configurado' });

    const { data, error } = await supabaseAdmin
      .from('activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error('[ADMIN_LOGS]', e);
    res.status(500).json({ error: 'Erro ao buscar logs' });
  }
});

// DELETE /api/admin/ocupacoes/:id — admin deletar ocupação
app.delete('/api/admin/ocupacoes/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const oid = Number(req.params.id);
    // Deletar checklists associados
    await dbRun('DELETE FROM checklists WHERE ocupacao_id = ?', [oid]);
    // Deletar ocupação
    await dbRun('DELETE FROM ocupacoes WHERE id = ?', [oid]);
    res.json({ message: 'Registro excluído com sucesso' });
  } catch (e) {
    console.error('[ADMIN_DEL_OCC]', e);
    res.status(500).json({ error: 'Erro ao excluir registro' });
  }
});

// ─────────────────────────────────────────────
//  UTIs  (protegidas por auth)
// ─────────────────────────────────────────────

app.get('/api/utis', requireAuth, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT u.id, u.nome,
        COUNT(l.id)                                          AS total_leitos,
        SUM(CASE WHEN o.ativa = 1 THEN 1 ELSE 0 END)        AS ocupados,
        COUNT(l.id) - SUM(CASE WHEN o.ativa = 1 THEN 1 ELSE 0 END) AS vagos
      FROM utis u
      JOIN leitos l ON l.uti_id = u.id AND l.ativo = 1
      LEFT JOIN ocupacoes o ON o.leito_id = l.id AND o.ativa = 1
      WHERE u.ativo = 1
      GROUP BY u.id, u.nome ORDER BY u.id
    `);
    res.json(rows);
  } catch (e) {
    console.error('[UTIS]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─────────────────────────────────────────────
//  LEITOS
// ─────────────────────────────────────────────

app.get('/api/utis/:id/leitos', requireAuth, async (req, res) => {
  try {
    const rows = await dbAll(`
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
    `, [Number(req.params.id)]);
    res.json(rows);
  } catch (e) {
    console.error('[LEITOS]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─────────────────────────────────────────────
//  OCUPACOES
// ─────────────────────────────────────────────

app.post('/api/leitos/:id/internar', requireAuth, async (req, res) => {
  try {
    const leitoId = Number(req.params.id);
    const nome = (req.body.nome_paciente || '').trim();
    const dob  = req.body.data_nascimento;

    if (!nome || !dob) {
      return res.status(400).json({ error: 'Nome e data de nascimento sao obrigatorios' });
    }

    const occupied = await dbGet('SELECT id FROM ocupacoes WHERE leito_id = ? AND ativa = 1', [leitoId]);
    if (occupied) {
      return res.status(409).json({ error: 'Leito ocupado. Registre a saida primeiro.' });
    }

    const result = await dbRun(
      'INSERT INTO ocupacoes (leito_id, nome_paciente, data_nascimento) VALUES (?, ?, ?)',
      [leitoId, nome, dob]
    );

    res.json({ id: result.lastID, message: 'Paciente internado com sucesso' });
  } catch (e) {
    console.error('[INTERNAR]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/ocupacoes/:id/saida', requireAuth, async (req, res) => {
  try {
    const oid    = Number(req.params.id);
    const motivo = req.body.motivo_saida;

    if (!['alta', 'obito'].includes(motivo)) {
      return res.status(400).json({ error: 'Motivo deve ser "alta" ou "obito"' });
    }

    const occ = await dbGet('SELECT id, ativa FROM ocupacoes WHERE id = ?', [oid]);
    if (!occ) return res.status(404).json({ error: 'Ocupacao nao encontrada' });
    if (!occ.ativa) return res.status(400).json({ error: 'Ocupacao ja encerrada' });

    await dbRun(
      "UPDATE ocupacoes SET ativa = 0, data_saida = datetime('now','localtime'), motivo_saida = ? WHERE id = ?",
      [motivo, oid]
    );

    res.json({ message: 'Saida registrada com sucesso' });
  } catch (e) {
    console.error('[SAIDA]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/historico', requireAuth, async (req, res) => {
  try {
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
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('[HISTORICO]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─────────────────────────────────────────────
//  CHECKLISTS
// ─────────────────────────────────────────────

app.get('/api/checklists/ocupacao/:id/data/:data', requireAuth, async (req, res) => {
  try {
    const row = await dbGet(
      'SELECT * FROM checklists WHERE ocupacao_id = ? AND data_registro = ?',
      [Number(req.params.id), req.params.data]
    );
    res.json(row || null);
  } catch (e) {
    console.error('[CHECKLIST_GET]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/checklists', requireAuth, async (req, res) => {
  try {
    const d    = req.body;
    const oid  = d.ocupacao_id;
    const lid  = d.leito_id;
    const dr   = d.data_registro;
    const prof = (d.profissional || '').trim();

    if (!oid || !lid || !dr || !prof) {
      return res.status(400).json({ error: 'Campos obrigatorios faltando' });
    }

    const occ = await dbGet('SELECT id FROM ocupacoes WHERE id = ?', [oid]);
    if (!occ) return res.status(404).json({ error: 'Internacao nao encontrada' });

    const fieldValues = [
      d.antibiotico,              d.dia_antibiotico || null,
      d.ventilacao,               d.dia_ventilacao  || null,
      d.dispositivo_venoso,       d.sonda_vesical,
      d.nutricao,                 d.vasopressor,
      d.sedacao,                  d.delirium,
      d.profilaxia_tev,           d.profilaxia_ue,
      d.mobilizacao,              d.dispositivos_necessarios,
      d.reavaliacao_atb || null,
      d.dias_vm || null,          d.dias_cvc || null,          d.dias_sonda || null,
      d.previsao_alta || null,
      prof
    ];

    const existing = await dbGet(
      'SELECT id FROM checklists WHERE ocupacao_id = ? AND data_registro = ?',
      [oid, dr]
    );

    if (existing) {
      await dbRun(`
        UPDATE checklists SET
          antibiotico=?, dia_antibiotico=?, ventilacao=?, dia_ventilacao=?,
          dispositivo_venoso=?, sonda_vesical=?, nutricao=?, vasopressor=?,
          sedacao=?, delirium=?, profilaxia_tev=?, profilaxia_ue=?,
          mobilizacao=?, dispositivos_necessarios=?,
          reavaliacao_atb=?, dias_vm=?, dias_cvc=?, dias_sonda=?,
          previsao_alta=?, profissional=?
        WHERE id = ?
      `, [...fieldValues, existing.id]);
      res.json({ id: existing.id, message: 'Checklist atualizado' });
    } else {
      const result = await dbRun(`
        INSERT INTO checklists (
          ocupacao_id, leito_id, data_registro,
          antibiotico, dia_antibiotico, ventilacao, dia_ventilacao,
          dispositivo_venoso, sonda_vesical, nutricao, vasopressor,
          sedacao, delirium, profilaxia_tev, profilaxia_ue,
          mobilizacao, dispositivos_necessarios,
          reavaliacao_atb, dias_vm, dias_cvc, dias_sonda,
          previsao_alta, profissional
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [oid, lid, dr, ...fieldValues]);
      res.json({ id: result.lastID, message: 'Checklist salvo' });
    }
  } catch (e) {
    console.error('[CHECKLIST_SAVE]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const utiId = req.query.uti_id;
    const defaultInicio = new Date(Date.now() - 29 * 86400000).toISOString().split('T')[0];
    const inicio = req.query.data_inicio || defaultInicio;
    const fim    = req.query.data_fim || hoje;

    const uf = utiId ? ' AND l.uti_id = ?' : '';
    const up = utiId ? [Number(utiId)] : [];

    const occ_stats = await dbAll(`
      SELECT u.id, u.nome,
        COUNT(l.id) AS total,
        SUM(CASE WHEN o.ativa = 1 THEN 1 ELSE 0 END) AS ocupados,
        COUNT(l.id) - SUM(CASE WHEN o.ativa = 1 THEN 1 ELSE 0 END) AS vagos
      FROM utis u
      JOIN leitos l ON l.uti_id = u.id AND l.ativo = 1
      LEFT JOIN ocupacoes o ON o.leito_id = l.id AND o.ativa = 1
      WHERE u.ativo = 1 GROUP BY u.id ORDER BY u.id
    `);

    const tpRow = await dbGet(
      `SELECT COUNT(*) AS n FROM ocupacoes o JOIN leitos l ON l.id = o.leito_id WHERE o.ativa = 1${uf}`,
      up
    );
    const totalPacientes = tpRow ? tpRow.n : 0;

    const hs = await dbGet(`
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
    `, [inicio, fim, ...up]);
    const hoje_stats = hs || {};

    const chRow = await dbGet(
      `SELECT COUNT(*) AS n FROM checklists c JOIN leitos l ON l.id = c.leito_id WHERE c.data_registro = ?${uf}`,
      [hoje, ...up]
    );
    const checklist_count_hoje = chRow ? chRow.n : 0;

    const avgRow = await dbGet(`
      SELECT AVG(CAST(
        COALESCE(julianday(o.data_saida), julianday('now')) - julianday(o.data_entrada)
      AS REAL)) AS v
      FROM ocupacoes o JOIN leitos l ON l.id = o.leito_id
      WHERE date(o.data_entrada) BETWEEN ? AND ?${uf}
    `, [inicio, fim, ...up]);
    const avg_los = avgRow && avgRow.v ? Math.round(avgRow.v * 10) / 10 : 0;

    const uf2 = utiId ? ` AND l2.uti_id = ${Number(utiId)}` : '';
    const trends = await dbAll(`
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
    `, [inicio, fim, ...up]);

    // Previsão de Alta
    const paQuery = `
      SELECT
        o.id AS ocupacao_id, o.nome_paciente,
        l.numero AS leito_numero, l.id AS leito_id,
        u.nome AS uti_nome, u.id AS uti_id,
        c.previsao_alta, c.data_registro
      FROM ocupacoes o
      JOIN leitos l ON l.id = o.leito_id
      JOIN utis u ON u.id = l.uti_id
      LEFT JOIN checklists c ON c.id = (
        SELECT c2.id FROM checklists c2
        WHERE c2.ocupacao_id = o.id AND c2.previsao_alta IS NOT NULL AND c2.previsao_alta != ''
        ORDER BY c2.data_registro DESC LIMIT 1
      )
      WHERE o.ativa = 1${uf.replace(/l\.uti_id/g, 'u.id')}
      ORDER BY u.id, CAST(l.numero AS INTEGER)
    `;
    const paPacientes = await dbAll(paQuery, up);
    const paResumo = { alta_hoje:0, alta_24h:0, alta_48h:0, alta_72h:0, sem_previsao:0, paliativos:0 };
    const pacientesComPrevisao = [];
    for (const p of paPacientes) {
      if (p.previsao_alta && paResumo.hasOwnProperty(p.previsao_alta)) {
        paResumo[p.previsao_alta]++;
        pacientesComPrevisao.push(p);
      }
    }

    res.json({
      totalPacientes,
      checklist_count_hoje,
      checklist_count_periodo: hoje_stats.total || 0,
      hoje_stats,
      avg_los,
      trends,
      occ_stats,
      periodo: { inicio, fim },
      previsao_alta: { resumo: paResumo, pacientes: pacientesComPrevisao }
    });
  } catch (e) {
    console.error('[DASHBOARD]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─────────────────────────────────────────────
//  EXPORT CSV
// ─────────────────────────────────────────────

app.get('/api/export/csv', requireAuth, async (req, res) => {
  try {
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

    const rows = await dbAll(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'Nenhum dado encontrado' });

    const headers = Object.keys(rows[0]);
    const csvLines = [
      headers.join(';'),
      ...rows.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(';'))
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="UTI_checklists.csv"');
    res.send('\uFEFF' + csvLines.join('\r\n'));
  } catch (e) {
    console.error('[CSV]', e);
    res.status(500).json({ error: 'Erro interno' });
  }
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

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n[OK] Monitor NEXO v4.0 rodando em http://localhost:${PORT}`);
      if (!SUPABASE_ANON_KEY) {
        console.log('[WARN] SUPABASE_ANON_KEY não definida — auth não funcionará');
      }
      console.log('');
    });
  })
  .catch(err => {
    console.error('[FATAL] Falha ao inicializar banco de dados:', err);
    process.exit(1);
  });
