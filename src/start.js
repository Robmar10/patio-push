'use strict';
// Ponto de entrada (npm start). Na ordem:
//  1. lê o .env (uso local);
//  2. se houver DATABASE_URL, restaura a cópia dos dados do Postgres externo ANTES de abrir o banco;
//  3. sobe o servidor web;
//  4. salva a cópia a cada alteração e uma última vez quando a nuvem manda desligar (SIGTERM).
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

(function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

const dbFile = path.resolve(ROOT, process.env.DB_FILE || 'data/patio.db');

(async () => {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const { createPersistence } = require('./persist');
  const persist = createPersistence(process.env.DATABASE_URL);
  if (persist) {
    try {
      await persist.restore(dbFile);
    } catch (e) {
      // Não sobe com banco vazio por cima de uma cópia que não conseguiu ler: evita apagar o histórico.
      console.error(`✖ Não foi possível ler a cópia no banco externo: ${e.message}`);
      console.error('  Confira a DATABASE_URL (Neon → Connection string). O sistema não vai iniciar para não sobrescrever os dados.');
      process.exit(1);
    }
  }

  const app = require('./server');
  const { CFG, db } = app.locals;
  app.locals.persist = persist;
  let watcher = null;
  if (persist) {
    await persist.save(db, dbFile).catch((e) => console.error('[cópia] falha na 1ª gravação:', e.message));
    watcher = persist.watch(db, dbFile);
  }

  const server = app.listen(CFG.port, CFG.host, () => {
    console.log(`Pátio Push no ar — porta ${CFG.port}`);
    console.log(`Endereço público: ${CFG.publicUrl || `http://localhost:${CFG.port}`}`);
    console.log('Telas: /  (portaria)  |  /equipe  |  /m/  (motorista)  |  /cartaz');
    if (persist) console.log('✔ Dados com cópia no banco externo (DATABASE_URL): sobrevivem a reinícios.');
    else if (CFG.cloud) console.log('⚠ SEM DATABASE_URL: na nuvem gratuita os dados são APAGADOS quando o serviço dorme ou reinicia.');
    if (CFG.cloud && (CFG.pin === '1234' || CFG.pin.length < 6)) console.log('⚠ PORTARIA_PIN não definido ou curto: o login fica bloqueado até configurar (mín. 6 dígitos).');
    else if (CFG.pin === '1234') console.log('⚠ PIN padrão 1234 em uso — defina PORTARIA_PIN no .env.');
  });

  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig} recebido — salvando dados e encerrando…`);
    server.close();
    try { if (watcher) await watcher.flush(); } catch (e) { console.error('[cópia] falha ao salvar no encerramento:', e.message); }
    try { if (persist) await persist.close(); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
})();
