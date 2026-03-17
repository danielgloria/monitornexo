/**
 * Monitor NEXO — Database Layer (Node.js / sqlite3 async)
 * Schema: utis, leitos, ocupacoes, checklists, usuarios, tokens_aprovacao, sessions
 */

const sqlite3 = require('sqlite3').verbose();
const path     = require('path');
const bcrypt   = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'uti.db');

const db = new sqlite3.Database(DB_PATH);

// ─── Promise wrappers ────────────────────────

/** db.run → { lastID, changes } */
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/** db.get → row | undefined */
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

/** db.all → rows[] */
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/** db.exec (multi-statement) */
function dbExec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ─────────────────────────────────────────────
//  MIGRATION — detect old schema and rename
// ─────────────────────────────────────────────

async function migrateDb() {
  const cols = await dbAll("PRAGMA table_info(checklists)");
  const colNames = cols.map(c => c.name);

  // Old v1 schema has paciente_id instead of ocupacao_id
  if (colNames.length && colNames.includes('paciente_id') && !colNames.includes('ocupacao_id')) {
    try { await dbExec('ALTER TABLE checklists RENAME TO checklists_v1_legacy'); } catch (_) {}
  }

  // Old patients table
  const oldTable = await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='patients'");
  if (oldTable) {
    try { await dbExec('ALTER TABLE patients RENAME TO patients_v1_legacy'); } catch (_) {}
  }

  // If new schema exists but missing new columns, add them
  if (colNames.length && colNames.includes('ocupacao_id')) {
    const newCols = {
      reavaliacao_atb: 'TEXT',
      dias_vm: 'INTEGER',
      dias_cvc: 'INTEGER',
      dias_sonda: 'INTEGER',
      previsao_alta: 'TEXT',
    };
    for (const [col, type] of Object.entries(newCols)) {
      if (!colNames.includes(col)) {
        try { await dbExec(`ALTER TABLE checklists ADD COLUMN ${col} ${type}`); } catch (_) {}
      }
    }
  }
}

// ─────────────────────────────────────────────
//  SCHEMA — create all tables
// ─────────────────────────────────────────────

async function createTables() {
  await dbExec(`
    CREATE TABLE IF NOT EXISTS utis (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      nome  TEXT NOT NULL UNIQUE,
      ativo INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS leitos (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      uti_id INTEGER NOT NULL,
      numero TEXT NOT NULL,
      ativo  INTEGER DEFAULT 1,
      FOREIGN KEY (uti_id) REFERENCES utis(id),
      UNIQUE(uti_id, numero)
    );

    CREATE TABLE IF NOT EXISTS ocupacoes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      leito_id        INTEGER NOT NULL,
      nome_paciente   TEXT NOT NULL,
      data_nascimento DATE NOT NULL,
      data_entrada    DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
      data_saida      DATETIME,
      motivo_saida    TEXT,
      ativa           INTEGER DEFAULT 1,
      created_at      DATETIME DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (leito_id) REFERENCES leitos(id)
    );

    CREATE TABLE IF NOT EXISTS checklists (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      ocupacao_id              INTEGER NOT NULL,
      leito_id                 INTEGER NOT NULL,
      data_registro            DATE NOT NULL,
      antibiotico              TEXT NOT NULL,
      dia_antibiotico          INTEGER,
      ventilacao               TEXT NOT NULL,
      dia_ventilacao           INTEGER,
      dispositivo_venoso       TEXT NOT NULL,
      sonda_vesical            TEXT NOT NULL,
      nutricao                 TEXT NOT NULL,
      vasopressor              TEXT NOT NULL,
      sedacao                  TEXT NOT NULL,
      delirium                 TEXT NOT NULL,
      profilaxia_tev           TEXT NOT NULL,
      profilaxia_ue            TEXT NOT NULL,
      mobilizacao              TEXT NOT NULL,
      dispositivos_necessarios TEXT NOT NULL,
      reavaliacao_atb          TEXT,
      dias_vm                  INTEGER,
      dias_cvc                 INTEGER,
      dias_sonda               INTEGER,
      previsao_alta            TEXT,
      profissional             TEXT NOT NULL,
      created_at               DATETIME DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (ocupacao_id) REFERENCES ocupacoes(id),
      FOREIGN KEY (leito_id)   REFERENCES leitos(id),
      UNIQUE(ocupacao_id, data_registro)
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      nome          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      senha_hash    TEXT NOT NULL,
      perfil        TEXT NOT NULL DEFAULT 'usuario',
      status        TEXT NOT NULL DEFAULT 'pendente',
      created_at    DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS tokens_aprovacao (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id  INTEGER NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      acao        TEXT NOT NULL,
      usado       INTEGER DEFAULT 0,
      expira_em   DATETIME NOT NULL,
      created_at  DATETIME DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT PRIMARY KEY,
      sess    TEXT NOT NULL,
      expired DATETIME NOT NULL
    );
  `);
}

// ─────────────────────────────────────────────
//  SEED — UTIs, leitos, admin user
// ─────────────────────────────────────────────

async function seedData() {
  const ADMIN_EMAIL    = 'danielvgloria@gmail.com';
  const ADMIN_PASSWORD = 'Kamila@221093';

  const utiConfig = [
    { nome: 'UTI 1', leitos: 8 },
    { nome: 'UTI 2', leitos: 10 },
    { nome: 'UTI 3', leitos: 10 },
  ];

  for (const cfg of utiConfig) {
    const existing = await dbGet('SELECT id FROM utis WHERE nome = ?', [cfg.nome]);
    if (!existing) {
      const result = await dbRun('INSERT INTO utis (nome) VALUES (?)', [cfg.nome]);
      const utiId = result.lastID;
      for (let i = 1; i <= cfg.leitos; i++) {
        await dbRun('INSERT INTO leitos (uti_id, numero) VALUES (?, ?)', [utiId, String(i).padStart(2, '0')]);
      }
    }
  }

  // Seed admin user
  const adminExists = await dbGet('SELECT id FROM usuarios WHERE email = ?', [ADMIN_EMAIL]);
  if (!adminExists) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    await dbRun(
      'INSERT INTO usuarios (nome, email, senha_hash, perfil, status) VALUES (?, ?, ?, ?, ?)',
      ['Administrador', ADMIN_EMAIL, hash, 'admin', 'aprovado']
    );
    console.log('[SEED] Admin user created:', ADMIN_EMAIL);
  }
}

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────

async function initDb() {
  // Enable WAL and foreign keys
  await dbRun('PRAGMA journal_mode = WAL');
  await dbRun('PRAGMA foreign_keys = ON');

  await migrateDb();
  await createTables();
  await seedData();
  console.log('[DB] Database initialized successfully');
}

module.exports = { db, dbRun, dbGet, dbAll, dbExec, initDb };
