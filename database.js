const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'uti.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS patients (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    nome                TEXT NOT NULL,
    numero_atendimento  TEXT NOT NULL UNIQUE,
    leito               TEXT NOT NULL,
    data_admissao       DATE NOT NULL,
    diagnostico         TEXT NOT NULL,
    idade               INTEGER NOT NULL,
    sexo                TEXT NOT NULL,
    ativo               INTEGER DEFAULT 1,
    data_alta           DATE,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS checklists (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id               INTEGER NOT NULL,
    data_registro             DATE NOT NULL,
    antibiotico               TEXT NOT NULL,
    dia_antibiotico           INTEGER,
    ventilacao                TEXT NOT NULL,
    dia_ventilacao            INTEGER,
    dispositivo_venoso        TEXT NOT NULL,
    sonda_vesical             TEXT NOT NULL,
    nutricao                  TEXT NOT NULL,
    vasopressor               TEXT NOT NULL,
    sedacao                   TEXT NOT NULL,
    delirium                  TEXT NOT NULL,
    profilaxia_tev            TEXT NOT NULL,
    profilaxia_ue             TEXT NOT NULL,
    mobilizacao               TEXT NOT NULL,
    dispositivos_necessarios  TEXT NOT NULL,
    profissional              TEXT NOT NULL,
    created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (paciente_id) REFERENCES patients(id),
    UNIQUE(paciente_id, data_registro)
  );
`);

module.exports = db;
