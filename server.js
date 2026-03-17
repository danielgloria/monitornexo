const express = require('express');
const path    = require('path');
const db      = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  PACIENTES
// ─────────────────────────────────────────────

// Listar pacientes ativos
app.get('/api/pacientes', (_req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      CAST(julianday('now') - julianday(p.data_admissao) AS INTEGER) AS dias_internacao
    FROM patients p
    WHERE p.ativo = 1
    ORDER BY p.leito COLLATE NOCASE
  `).all();
  res.json(rows);
});

// Listar todos os pacientes (incluindo alta)
app.get('/api/pacientes/todos', (_req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      CAST(COALESCE(julianday(p.data_alta), julianday('now')) - julianday(p.data_admissao) AS INTEGER) AS dias_internacao
    FROM patients p
    ORDER BY p.ativo DESC, p.leito COLLATE NOCASE
  `).all();
  res.json(rows);
});

// Buscar paciente por ID
app.get('/api/pacientes/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Paciente não encontrado' });
  res.json(row);
});

// Cadastrar paciente
app.post('/api/pacientes', (req, res) => {
  const { nome, numero_atendimento, leito, data_admissao, diagnostico, idade, sexo } = req.body;
  if (!nome || !numero_atendimento || !leito || !data_admissao || !diagnostico || !idade || !sexo) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }
  try {
    const r = db.prepare(`
      INSERT INTO patients (nome, numero_atendimento, leito, data_admissao, diagnostico, idade, sexo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(nome.trim(), numero_atendimento.trim(), leito.trim(), data_admissao, diagnostico.trim(), Number(idade), sexo);
    res.json({ id: r.lastInsertRowid, message: 'Paciente cadastrado com sucesso' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Número de atendimento já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});

// Atualizar paciente
app.put('/api/pacientes/:id', (req, res) => {
  const { nome, numero_atendimento, leito, data_admissao, diagnostico, idade, sexo } = req.body;
  try {
    db.prepare(`
      UPDATE patients SET nome=?, numero_atendimento=?, leito=?, data_admissao=?, diagnostico=?, idade=?, sexo=?
      WHERE id=?
    `).run(nome.trim(), numero_atendimento.trim(), leito.trim(), data_admissao, diagnostico.trim(), Number(idade), sexo, req.params.id);
    res.json({ message: 'Paciente atualizado' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Número de atendimento já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});

// Alta do paciente
app.post('/api/pacientes/:id/alta', (req, res) => {
  const data_alta = req.body.data_alta || new Date().toISOString().split('T')[0];
  db.prepare('UPDATE patients SET ativo=0, data_alta=? WHERE id=?').run(data_alta, req.params.id);
  res.json({ message: 'Alta registrada' });
});

// Reativar paciente
app.post('/api/pacientes/:id/reativar', (req, res) => {
  db.prepare('UPDATE patients SET ativo=1, data_alta=NULL WHERE id=?').run(req.params.id);
  res.json({ message: 'Paciente reativado' });
});

// ─────────────────────────────────────────────
//  CHECKLISTS
// ─────────────────────────────────────────────

// Listar checklists de um paciente
app.get('/api/checklists/paciente/:id', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, p.nome, p.leito FROM checklists c
    JOIN patients p ON p.id = c.paciente_id
    WHERE c.paciente_id = ? ORDER BY c.data_registro DESC
  `).all(req.params.id);
  res.json(rows);
});

// Buscar checklist específico (paciente + data)
app.get('/api/checklists/paciente/:id/data/:data', (req, res) => {
  const row = db.prepare('SELECT * FROM checklists WHERE paciente_id=? AND data_registro=?')
    .get(req.params.id, req.params.data);
  res.json(row || null);
});

// Listar todos os checklists (com filtros)
app.get('/api/checklists', (req, res) => {
  const { data_inicio, data_fim, paciente_id } = req.query;
  let sql = `
    SELECT c.*, p.nome, p.leito, p.numero_atendimento, p.diagnostico, p.idade, p.sexo
    FROM checklists c
    JOIN patients p ON p.id = c.paciente_id
    WHERE 1=1
  `;
  const params = [];
  if (data_inicio) { sql += ' AND c.data_registro >= ?'; params.push(data_inicio); }
  if (data_fim)    { sql += ' AND c.data_registro <= ?'; params.push(data_fim); }
  if (paciente_id) { sql += ' AND c.paciente_id = ?';    params.push(paciente_id); }
  sql += ' ORDER BY c.data_registro DESC, p.leito COLLATE NOCASE';
  res.json(db.prepare(sql).all(...params));
});

// Criar ou atualizar checklist
app.post('/api/checklists', (req, res) => {
  const {
    paciente_id, data_registro, antibiotico, dia_antibiotico, ventilacao, dia_ventilacao,
    dispositivo_venoso, sonda_vesical, nutricao, vasopressor, sedacao, delirium,
    profilaxia_tev, profilaxia_ue, mobilizacao, dispositivos_necessarios, profissional
  } = req.body;

  if (!paciente_id || !data_registro || !profissional) {
    return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  }

  try {
    const existing = db.prepare('SELECT id FROM checklists WHERE paciente_id=? AND data_registro=?')
      .get(paciente_id, data_registro);

    const fields = [
      antibiotico, dia_antibiotico || null, ventilacao, dia_ventilacao || null,
      dispositivo_venoso, sonda_vesical, nutricao, vasopressor, sedacao, delirium,
      profilaxia_tev, profilaxia_ue, mobilizacao, dispositivos_necessarios, profissional.trim()
    ];

    if (existing) {
      db.prepare(`
        UPDATE checklists SET
          antibiotico=?, dia_antibiotico=?, ventilacao=?, dia_ventilacao=?,
          dispositivo_venoso=?, sonda_vesical=?, nutricao=?, vasopressor=?, sedacao=?, delirium=?,
          profilaxia_tev=?, profilaxia_ue=?, mobilizacao=?, dispositivos_necessarios=?, profissional=?
        WHERE id=?
      `).run(...fields, existing.id);
      res.json({ id: existing.id, message: 'Checklist atualizado' });
    } else {
      const r = db.prepare(`
        INSERT INTO checklists (
          paciente_id, data_registro,
          antibiotico, dia_antibiotico, ventilacao, dia_ventilacao,
          dispositivo_venoso, sonda_vesical, nutricao, vasopressor, sedacao, delirium,
          profilaxia_tev, profilaxia_ue, mobilizacao, dispositivos_necessarios, profissional
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(paciente_id, data_registro, ...fields);
      res.json({ id: r.lastInsertRowid, message: 'Checklist salvo' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────

app.get('/api/dashboard', (req, res) => {
  const hoje   = new Date().toISOString().split('T')[0];
  const inicio = req.query.data_inicio || (() => {
    const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0];
  })();
  const fim = req.query.data_fim || hoje;

  const totalPacientes = db.prepare("SELECT COUNT(*) AS n FROM patients WHERE ativo=1").get().n;

  const hoje_stats = db.prepare(`
    SELECT
      COUNT(*)                                                             AS total,
      SUM(CASE WHEN ventilacao='vmi'                        THEN 1 ELSE 0 END) AS ventilados_vmi,
      SUM(CASE WHEN ventilacao IN ('vmi','vni')              THEN 1 ELSE 0 END) AS ventilados_qualquer,
      SUM(CASE WHEN antibiotico='sim'                        THEN 1 ELSE 0 END) AS uso_atb,
      SUM(CASE WHEN dispositivo_venoso IN ('cvc','picc')     THEN 1 ELSE 0 END) AS uso_dvc,
      SUM(CASE WHEN sonda_vesical='sim'                      THEN 1 ELSE 0 END) AS uso_svd,
      SUM(CASE WHEN vasopressor='sim'                        THEN 1 ELSE 0 END) AS uso_vaso,
      SUM(CASE WHEN delirium='positivo'                      THEN 1 ELSE 0 END) AS delirium_pos,
      SUM(CASE WHEN mobilizacao IN ('sedestacao','ortostatismo','deambulacao') THEN 1 ELSE 0 END) AS mobilizados,
      SUM(CASE WHEN profilaxia_tev IN ('farmacologica','mecanica')            THEN 1 ELSE 0 END) AS prof_tev_ok,
      AVG(CASE WHEN ventilacao='vmi' AND dia_ventilacao IS NOT NULL THEN CAST(dia_ventilacao AS REAL) END) AS media_dias_vm,
      AVG(CASE WHEN antibiotico='sim' AND dia_antibiotico IS NOT NULL THEN CAST(dia_antibiotico AS REAL) END) AS media_dias_atb
    FROM checklists WHERE data_registro = ?
  `).get(hoje);

  const checklist_count_hoje = hoje_stats.total || 0;

  const avg_los = db.prepare(`
    SELECT AVG(
      CAST(COALESCE(julianday(data_alta), julianday('now')) - julianday(data_admissao) AS REAL)
    ) AS v FROM patients WHERE data_admissao BETWEEN ? AND ?
  `).get(inicio, fim).v;

  const trends = db.prepare(`
    SELECT
      data_registro,
      COUNT(*) AS total,
      SUM(CASE WHEN ventilacao='vmi'              THEN 1 ELSE 0 END) AS vmi,
      SUM(CASE WHEN antibiotico='sim'             THEN 1 ELSE 0 END) AS atb,
      SUM(CASE WHEN delirium='positivo'           THEN 1 ELSE 0 END) AS delirium,
      SUM(CASE WHEN mobilizacao IN ('sedestacao','ortostatismo','deambulacao') THEN 1 ELSE 0 END) AS mobilizados,
      SUM(CASE WHEN vasopressor='sim'             THEN 1 ELSE 0 END) AS vasopressor,
      SUM(CASE WHEN sonda_vesical='sim'           THEN 1 ELSE 0 END) AS svd,
      SUM(CASE WHEN dispositivo_venoso IN ('cvc','picc') THEN 1 ELSE 0 END) AS dvc
    FROM checklists
    WHERE data_registro BETWEEN ? AND ?
    GROUP BY data_registro ORDER BY data_registro
  `).all(inicio, fim);

  res.json({
    totalPacientes,
    checklist_count_hoje,
    hoje_stats,
    avg_los: avg_los ? Math.round(avg_los * 10) / 10 : 0,
    trends,
    periodo: { inicio, fim }
  });
});

// ─────────────────────────────────────────────
//  EXPORTAÇÃO CSV
// ─────────────────────────────────────────────

app.get('/api/export/csv', (req, res) => {
  const { data_inicio, data_fim, paciente_id } = req.query;
  let sql = `
    SELECT
      p.leito, p.nome, p.numero_atendimento, p.diagnostico, p.idade, p.sexo,
      c.data_registro,
      c.antibiotico, c.dia_antibiotico,
      c.ventilacao, c.dia_ventilacao,
      c.dispositivo_venoso, c.sonda_vesical, c.nutricao,
      c.vasopressor, c.sedacao, c.delirium,
      c.profilaxia_tev, c.profilaxia_ue,
      c.mobilizacao, c.dispositivos_necessarios,
      c.profissional
    FROM checklists c JOIN patients p ON p.id = c.paciente_id WHERE 1=1
  `;
  const params = [];
  if (data_inicio) { sql += ' AND c.data_registro >= ?'; params.push(data_inicio); }
  if (data_fim)    { sql += ' AND c.data_registro <= ?'; params.push(data_fim); }
  if (paciente_id) { sql += ' AND c.paciente_id = ?';   params.push(paciente_id); }
  sql += ' ORDER BY c.data_registro DESC, p.leito COLLATE NOCASE';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return res.status(404).json({ error: 'Nenhum dado encontrado' });

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(';'),
    ...rows.map(r => headers.map(h => `"${(r[h] ?? '').toString().replace(/"/g, '""')}"`).join(';'))
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="UTI_dados_${data_inicio||'all'}_${data_fim||'all'}.csv"`);
  res.send('\uFEFF' + csv);
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✔  UTI Monitor rodando em http://localhost:${PORT}\n`);
});
