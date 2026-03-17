/**
 * Monitor NEXO — Database Layer (Node.js / better-sqlite3)
 * Schema: utis, leitos, ocupacoes, checklists, usuarios, tokens_aprovacao, sessions
 */

const Database = require('better-sqlite3');
const path     = require('path');
const bcrypt   = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'uti.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─────────────────────────────────────────────
//  MIGRATION — detect old schema and rename
// ─────────────────────────────────────────────

function migrateDb() {
  const cols = db.pragma('table_info(checklists)').map(c => c.name);

  // Old v1 schema has paciente_id instead of ocupacao_id
  if (cols.length && cols.includes('paciente_id') && !cols.includes('ocupacao_id')) {
    try { db.exec('ALTER TABLE checklists RENAME TO checklists_v1_legacy'); } catch (_) {}
  }

  // Old patients table
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='patients'").get();
  if (tables) {
    try { db.exec('ALTER TABLE patients RENAME TO patients_v1_legacy'); } catch (_) {}
  }

  // If new schema exists but missing new columns, add them
  if (cols.length && cols.includes('ocupacao_id')) {
    const newCols = {
      reavaliacao_atb: 'TEXT',
      dias_vm: 'INTEGER',
      dias_cvc: 'INTEGER',
      dias_sonda: 'INTEGER',
      previsao_alta: 'TEXT',
    };
    for (const [col, type] of Object.entries(newCols)) {
      if (!cols.includes(col)) {
        try { db.exec(`ALTER TABLE checklists ADD COLUMN ${col} ${type}`); } catch (_) {}
      }
    }
  }
}

// ─────────────────────────────────────────────
//  SCHEMA — create all tables
// ─────────────────────────────────────────────

function createTables() {
  db.exec(`
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

function seedData() {
  const ADMIN_EMAIL    = 'danielvgloria@gmail.com';
  const ADMIN_PASSWORD = 'Kamila@221093';

  const utiConfig = [
    { nome: 'UTI 1', leitos: 8 },
    { nome: 'UTI 2', leitos: 10 },
    { nome: 'UTI 3', leitos: 10 },
  ];

  const insertUti   = db.prepare('INSERT INTO utis (nome) VALUES (?)');
  const insertLeito = db.prepare('INSERT INTO leitos (uti_id, numero) VALUES (?, ?)');
  const checkUti    = db.prepare('SELECT id FROM utis WHERE nome = ?');

  for (const cfg of utiConfig) {
    const existing = checkUti.get(cfg.nome);
    if (!existing) {
      const result = insertUti.run(cfg.nome);
      const utiId = result.lastInsertRowid;
      for (let i = 1; i <= cfg.leitos; i++) {
        insertLeito.run(utiId, String(i).padStart(2, '0'));
      }
    }
  }

  // Seed admin user
  const adminExists = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(ADMIN_EMAIL);
  if (!adminExists) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    db.prepare(
      'INSERT INTO usuarios (nome, email, senha_hash, perfil, status) VALUES (?, ?, ?, ?, ?)'
    ).run('Administrador', ADMIN_EMAIL, hash, 'admin', 'aprovado');
    console.log('[SEED] Admin user created:', ADMIN_EMAIL);
  }
}

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────

function initDb() {
  migrateDb();
  createTables();
  seedData();
  console.log('[DB] Database initialized successfully');
}

module.exports = { db, initDb };
