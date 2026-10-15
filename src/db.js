'use strict';
// Banco persistente: SQLite nativo do Node.js 22.5+ (arquivo em data/).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auth_code TEXT NOT NULL UNIQUE,          -- autorização de entrada (ex.: R-0007 / E-0012)
    driver_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    plate TEXT NOT NULL,
    carrier TEXT NOT NULL,
    op_type TEXT NOT NULL CHECK (op_type IN ('RECEBIMENTO','EXPEDICAO')),
    cargo TEXT NOT NULL,
    partner TEXT,                            -- fornecedor (recebimento) ou cliente (expedição)
    status TEXT NOT NULL DEFAULT 'AGUARDANDO'
      CHECK (status IN ('AGUARDANDO','CHAMADO','CONFIRMADO','NA_DOCA','FINALIZADO','ATENDIDO','CANCELADO')),
    dock TEXT,
    driver_token TEXT NOT NULL UNIQUE,       -- vincula o celular do motorista a esta visita
    driver_linked_at TEXT,                   -- quando o motorista abriu a página pelo QR
    push_enabled INTEGER NOT NULL DEFAULT 0,
    call_count INTEGER NOT NULL DEFAULT 0,
    arrived_at TEXT NOT NULL,
    called_at TEXT,
    confirmed_at TEXT,
    attended_at TEXT,
    closed_at TEXT,
    created_by TEXT NOT NULL,
    called_by TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
  CREATE INDEX IF NOT EXISTS idx_visits_plate ON visits(plate);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id INTEGER NOT NULL REFERENCES visits(id),
    endpoint TEXT NOT NULL UNIQUE,
    keys TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS docks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id INTEGER,
    type TEXT NOT NULL,
    detail TEXT,
    actor TEXT,
    created_at TEXT NOT NULL
  );
  `);
  // Bancos criados por versões anteriores: a regra de status não tinha NA_DOCA/FINALIZADO.
  // O SQLite não altera CHECK, então a tabela é recriada com os mesmos dados.
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='visits'").get() || {}).sql || '';
  if (ddl && !ddl.includes('NA_DOCA')) {
    const newDdl = ddl.replace(/CHECK \(status IN \([^)]*\)\)/, "CHECK (status IN ('AGUARDANDO','CHAMADO','CONFIRMADO','NA_DOCA','FINALIZADO','ATENDIDO','CANCELADO'))")
      .replace(/CREATE TABLE (IF NOT EXISTS )?"?visits"?/, 'CREATE TABLE visits_new');
    db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    db.exec(newDdl);
    const cols0 = db.prepare('PRAGMA table_info(visits)').all().map((c) => c.name).join(', ');
    db.exec(`INSERT INTO visits_new (${cols0}) SELECT ${cols0} FROM visits; DROP TABLE visits; ALTER TABLE visits_new RENAME TO visits;`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status); CREATE INDEX IF NOT EXISTS idx_visits_plate ON visits(plate); COMMIT; PRAGMA foreign_keys = ON;');
  }
  // Colunas acrescentadas depois da 1ª versão: alerta da equipe e chamada com o caminhão na doca.
  const cols = db.prepare('PRAGMA table_info(visits)').all().map((c) => c.name);
  for (const [c, t] of [['team_alert_at', 'TEXT'], ['team_alert_kind', 'TEXT'], ['team_ack_at', 'TEXT'], ['team_ack_by', 'TEXT'],
    ['docked_at', 'TEXT'], ['finished_at', 'TEXT'], ['dock_call_reason', 'TEXT'], ['dock_call_at', 'TEXT'], ['dock_call_acked_at', 'TEXT'],
    ['dock_call_count', 'INTEGER NOT NULL DEFAULT 0'], ['handled_by', 'TEXT'],
    // v3: recados com local, transferência entre equipes, saída na portaria, confirmação de entrega no celular
    ['dock_call_place', 'TEXT'], ['dock_call_text', 'TEXT'],
    ['next_op', 'TEXT'], ['queued_at', 'TEXT'], ['leg', 'INTEGER NOT NULL DEFAULT 1'], ['prev_dock', 'TEXT'],
    ['exited_at', 'TEXT'], ['exited_by', 'TEXT'],
    ['last_ring_at', 'TEXT'], ['push_receipt_at', 'TEXT'], ['test_ok_at', 'TEXT']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE visits ADD COLUMN ${c} ${t}`);
  }
  db.exec('UPDATE visits SET queued_at = arrived_at WHERE queued_at IS NULL');
  if (db.prepare('SELECT COUNT(*) n FROM docks').get().n === 0) {
    const ins = db.prepare('INSERT INTO docks (name, sort) VALUES (?, ?)');
    for (let i = 1; i <= 10; i++) ins.run(`DOCA ${String(i).padStart(2, '0')}`, i);
    ins.run('PÁTIO INTERNO', 50);
    ins.run('BALANÇA', 51);
  }
  return db;
}

module.exports = { open };
