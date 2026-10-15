'use strict';
// Cópia de segurança do banco em um Postgres externo (ex.: Neon, gratuito).
// Motivo: na camada gratuita do Render o disco é apagado quando o serviço dorme,
// reinicia ou é atualizado. O sistema continua usando SQLite localmente (rápido e simples)
// e guarda uma cópia do arquivo inteiro no Postgres sempre que algo muda.
// Ao iniciar, restaura essa cópia antes de abrir o banco.
// Sem DATABASE_URL, nada disso roda e os dados ficam só no disco local.
const fs = require('fs');

const TABLE = 'patio_push_snapshot';

function ssl(url) {
  // Neon e a maioria dos Postgres na nuvem exigem TLS; local/teste pode desligar com ?sslmode=disable
  return /sslmode=disable/.test(url) ? false : { rejectUnauthorized: true };
}

function createPersistence(url, log = console.log) {
  if (!url) return null;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url.replace(/[?&]sslmode=disable/, ''), ssl: ssl(url), max: 2, idleTimeoutMillis: 30000 });
  pool.on('error', (e) => log(`[cópia] conexão perdida com o banco externo: ${e.message}`));

  let lastSavedAt = null;
  let lastError = null;

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INT PRIMARY KEY, data BYTEA NOT NULL, saved_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  }

  // Grava o arquivo salvo no Postgres sobre o arquivo local (antes de abrir o SQLite).
  async function restore(dbFile) {
    await init();
    const r = await pool.query(`SELECT data, saved_at FROM ${TABLE} WHERE id = 1`);
    if (!r.rows.length) { log('[cópia] nenhuma cópia anterior no banco externo — começando do zero.'); return false; }
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* não existia */ } }
    fs.writeFileSync(dbFile, r.rows[0].data);
    lastSavedAt = r.rows[0].saved_at;
    log(`[cópia] dados restaurados do banco externo (salvos em ${new Date(r.rows[0].saved_at).toISOString()}, ${r.rows[0].data.length} bytes).`);
    return true;
  }

  // Lê o arquivo SQLite consolidado e envia ao Postgres.
  async function save(db, dbFile) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const data = fs.readFileSync(dbFile); // leitura síncrona logo após o checkpoint: nenhuma escrita intercala
    await pool.query(
      `INSERT INTO ${TABLE} (id, data, saved_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, saved_at = now()`, [data]);
    lastSavedAt = new Date();
    lastError = null;
  }

  // Verifica a cada `ms` se houve alteração (total_changes) e salva só quando mudou.
  function watch(db, dbFile, ms = 4000) {
    let last = changes(db);
    let busy = false;
    const tick = async () => {
      if (busy) return;
      const now = changes(db);
      if (now === last) return;
      busy = true;
      try { await save(db, dbFile); last = now; } catch (e) { lastError = e.message; log(`[cópia] falha ao salvar: ${e.message} (tentará de novo)`); } finally { busy = false; }
    };
    const t = setInterval(tick, ms);
    return { flush: async () => { clearInterval(t); last = -1; await tick(); } };
  }

  return {
    restore, save, watch,
    status: () => ({ enabled: true, lastSavedAt, lastError }),
    close: () => pool.end(),
  };
}

function changes(db) { return db.prepare('SELECT total_changes() AS n').get().n; }

module.exports = { createPersistence };
