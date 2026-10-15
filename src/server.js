'use strict';
// PÁTIO PUSH — protótipo de controle de pátio e chamada de motoristas por notificação gratuita.
// Portaria cadastra a chegada (autorização), o dashboard mostra a fila e a portaria chama;
// o celular do motorista (página aberta via QR Code) recebe a chamada em tempo real (SSE)
// e, se ele permitiu notificações, também por Web Push — sem custo de SMS.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const webpush = require('web-push');
const QRCode = require('qrcode');

const ROOT = path.resolve(__dirname, '..');

// ---------- Configuração (.env opcional) ----------
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
const env = (k, d = '') => (process.env[k] ? process.env[k] : d);
const CFG = {
  port: Number(env('PORT', '3100')),
  host: env('HOST', '0.0.0.0'),
  // Na nuvem (Render) o endereço público vem pronto em RENDER_EXTERNAL_URL.
  publicUrl: env('PUBLIC_URL', env('RENDER_EXTERNAL_URL', '')).replace(/\/+$/, ''),
  pin: env('PORTARIA_PIN', '1234'),
  cloud: Boolean(process.env.RENDER),
  persistent: Boolean(process.env.DATABASE_URL),
  dbFile: path.resolve(ROOT, env('DB_FILE', 'data/patio.db')),
  vapidSubject: env('VAPID_SUBJECT', 'mailto:logistica@example.com'),
  siteName: env('SITE_NAME', 'Portaria · Controle de Pátio'),
  tzOffset: env('APP_TZ_OFFSET', '-03:00'),
};

const db = require('./db').open(CFG.dbFile);
const now = () => new Date().toISOString();
const clean = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const bad = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });
const logEvent = (visit_id, type, detail, actor) =>
  db.prepare('INSERT INTO events (visit_id, type, detail, actor, created_at) VALUES (?,?,?,?,?)')
    .run(visit_id ?? null, type, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)), actor ?? null, now());

// ---------- Web Push (VAPID gerado automaticamente na 1ª execução) ----------
// Ordem: variáveis VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY → chave guardada no banco → gera e guarda no banco.
// Guardar no banco faz a chave sobreviver na nuvem (o banco tem cópia no Postgres externo).
const getSetting = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
let vapid;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else if (getSetting('vapid')) {
  vapid = JSON.parse(getSetting('vapid'));
} else {
  const legacy = path.join(path.dirname(CFG.dbFile), 'vapid.json');
  vapid = fs.existsSync(legacy) ? JSON.parse(fs.readFileSync(legacy, 'utf8')) : webpush.generateVAPIDKeys();
  setSetting('vapid', JSON.stringify(vapid));
}
webpush.setVapidDetails(CFG.vapidSubject, vapid.publicKey, vapid.privateKey);

async function pushToVisit(visit, payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE visit_id = ?').all(visit.id);
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(payload), { TTL: 600, urgency: 'high' });
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      logEvent(visit.id, 'PUSH_FALHOU', { status: e.statusCode, msg: String(e.body || e.message).slice(0, 200) }, 'sistema');
    }
  }
  return { subscriptions: subs.length, delivered_to_push_service: ok };
}

// ---------- Tempo real (Server-Sent Events) ----------
const clients = new Set(); // { res, kind: 'staff'|'driver', visitId }
function sse(req, res, client) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  client.res = res;
  clients.add(client);
  req.on('close', () => clients.delete(client));
}
function emit(filter, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (filter(c)) c.res.write(msg);
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();

const getVisit = (id) => db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
const ACTIVE = ['AGUARDANDO', 'CHAMADO', 'CONFIRMADO', 'NA_DOCA'];
// Chamada feita com o caminhão já na doca, ainda sem resposta do motorista.
const dockPending = (v) => v.status === 'NA_DOCA' && !!v.dock_call_at && (!v.dock_call_acked_at || v.dock_call_acked_at < v.dock_call_at);
// Motivos de chamada na doca (texto do celular e da notificação).
const REASONS = {
  CONCLUIDO: { label: 'Carga/descarga concluída', head: 'RETIRE O CAMINHÃO', text: (d) => `Carga/descarga concluída. Retire o caminhão da ${d}.` },
  CAMINHAO: { label: 'Comparecer ao caminhão', head: 'VÁ ATÉ O CAMINHÃO', text: (d) => `Compareça ao seu caminhão na ${d}.` },
  DOCUMENTOS: { label: 'Nota fiscal / documentos', head: 'LEVE OS DOCUMENTOS', text: (d) => `Apresente a nota fiscal / documentos na ${d}.` },
  MUDAR: { label: 'Mudar de doca', head: 'MUDE DE DOCA', text: (d) => `Leve o caminhão para a ${d}.` },
};
function queuePosition(v) {
  if (v.status !== 'AGUARDANDO') return 0;
  // posição na fila da própria equipe (Recebimento e Expedição chamam separadamente)
  return db.prepare(`SELECT COUNT(*) n FROM visits WHERE status = 'AGUARDANDO' AND op_type = ? AND arrived_at <= ?`).get(v.op_type, v.arrived_at).n;
}
// O que o celular do motorista pode ver (sem dados de outros motoristas).
function driverView(v) {
  return {
    first_name: v.driver_name.split(' ')[0], plate: v.plate, op_type: v.op_type, auth_code: v.auth_code,
    status: v.status, dock: v.dock, call_count: v.call_count, called_at: v.called_at, arrived_at: v.arrived_at,
    position: queuePosition(v), push_enabled: !!v.push_enabled,
    team: v.op_type === 'RECEBIMENTO' ? 'Recebimento' : 'Expedição',
    dock_call: v.dock_call_at ? { reason: v.dock_call_reason, at: v.dock_call_at, acked_at: v.dock_call_acked_at, count: v.dock_call_count } : null,
    dock_call_pending: dockPending(v),
  };
}
function broadcastVisit(id) {
  const v = getVisit(id);
  if (!v) return;
  emit((c) => c.kind === 'staff', 'visit', staffView(v));
  emit((c) => c.kind === 'driver' && c.visitId === id, 'state', driverView(v));
  // posição na fila dos demais motoristas aguardando muda quando alguém sai da fila
  for (const c of clients) {
    if (c.kind === 'driver' && c.visitId !== id) {
      const o = getVisit(c.visitId);
      if (o && o.status === 'AGUARDANDO') c.res.write(`event: state\ndata: ${JSON.stringify(driverView(o))}\n\n`);
    }
  }
}
// Alerta para a tela da equipe (recebimento/expedição): fica pendente até alguém dar CIENTE.
function teamAlert(id, kind) {
  db.prepare('UPDATE visits SET team_alert_at = ?, team_alert_kind = ? WHERE id = ?').run(now(), kind, id);
  const v = getVisit(id);
  emit((c) => c.kind === 'staff', 'team_alert', staffView(v));
}
function staffView(v) {
  const online = [...clients].some((c) => c.kind === 'driver' && c.visitId === v.id);
  const { driver_token, ...rest } = v; // eslint-disable-line no-unused-vars
  return { ...rest, driver_online: online };
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
// Na nuvem há um proxy HTTPS na frente: confiar nele para saber o IP real e que a conexão é segura.
app.set('trust proxy', CFG.cloud ? 1 : 'loopback, linklocal, uniquelocal');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) return bad(res, 415, 'Envie JSON.');
  next();
});

const baseUrl = (req) => CFG.publicUrl || `${req.protocol}://${req.get('host')}`;

// ---------- Sessão da portaria (PIN) ----------
const sessions = new Map();
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
function staff(req, res, next) {
  const s = sessions.get(cookies(req).pp_sid);
  if (!s || s.exp < Date.now()) return bad(res, 401, 'Entre com o PIN da portaria.');
  req.op = s.name;
  next();
}
const attempts = new Map();
function limited(req, key, max) {
  const k = `${key}:${req.ip}`;
  const a = attempts.get(k) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 10 * 60e3) { a.n = 0; a.t = Date.now(); }
  a.n++;
  attempts.set(k, a);
  return a.n > max;
}

// Na internet, o PIN padrão ou curto deixaria o painel aberto a qualquer pessoa.
const weakPin = () => CFG.cloud && (CFG.pin === '1234' || CFG.pin.length < 6);

app.post('/api/login', (req, res) => {
  if (limited(req, 'login', 8)) return bad(res, 429, 'Muitas tentativas. Aguarde 10 minutos.');
  const name = clean(req.body.name, 40);
  if (name.length < 2) return bad(res, 400, 'Informe seu nome.');
  if (weakPin()) return bad(res, 503, 'Sistema na internet com PIN padrão. O administrador precisa definir PORTARIA_PIN (mín. 6 dígitos) nas configurações do servidor.');
  const pin = String(req.body.pin || '');
  const a = Buffer.from(pin); const b = Buffer.from(CFG.pin);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return bad(res, 401, 'PIN incorreto.');
  const tok = crypto.randomBytes(24).toString('hex');
  sessions.set(tok, { name, exp: Date.now() + 12 * 3600e3 });
  res.setHeader('Set-Cookie', `pp_sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.secure ? '; Secure' : ''}`);
  res.json({ name });
});
app.post('/api/logout', staff, (req, res) => {
  sessions.delete(cookies(req).pp_sid);
  res.setHeader('Set-Cookie', 'pp_sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
function storageInfo() {
  const p = app.locals.persist;
  if (!p) return { mode: CFG.cloud ? 'TEMPORARIO' : 'LOCAL' };
  const st = p.status();
  return { mode: 'COPIA_EXTERNA', lastSavedAt: st.lastSavedAt, lastError: st.lastError };
}
app.get('/api/me', staff, (req, res) => res.json({ name: req.op, siteName: CFG.siteName, publicUrl: CFG.publicUrl || null, storage: storageInfo() }));
// Usado pelo Render para saber se o serviço está no ar e pelas telas para mantê-lo acordado.
app.get('/health', (req, res) => res.json({ ok: true, storage: storageInfo().mode, time: now() }));

// ---------- Cadastro de chegada (autorização) ----------
const PLATE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;
const normPlate = (p) => clean(p, 10).toUpperCase().replace(/[\s-]/g, '');
const normPhone = (p) => String(p || '').replace(/\D/g, '');

app.post('/api/visits', staff, async (req, res) => {
  const b = req.body || {};
  const v = {
    driver_name: clean(b.driver_name, 80), phone: normPhone(b.phone), plate: normPlate(b.plate), carrier: clean(b.carrier, 80),
    op_type: b.op_type === 'EXPEDICAO' ? 'EXPEDICAO' : b.op_type === 'RECEBIMENTO' ? 'RECEBIMENTO' : '',
    cargo: clean(b.cargo, 200), partner: clean(b.partner, 80) || null, note: clean(b.note, 200) || null,
  };
  const errs = [];
  if (v.driver_name.length < 3) errs.push('Nome do motorista obrigatório.');
  if (v.phone.length < 10 || v.phone.length > 13) errs.push('Celular com DDD obrigatório.');
  if (!PLATE.test(v.plate)) errs.push('Placa inválida (ABC1D23 ou ABC1234).');
  if (v.carrier.length < 2) errs.push('Transportadora obrigatória.');
  if (!v.op_type) errs.push('Escolha Recebimento ou Expedição.');
  if (v.cargo.length < 2) errs.push('Descreva a carga.');
  if (errs.length) return bad(res, 400, errs.join(' '));
  const dup = db.prepare(`SELECT auth_code FROM visits WHERE plate = ? AND status IN ('AGUARDANDO','CHAMADO','CONFIRMADO','NA_DOCA')`).get(v.plate);
  if (dup) return bad(res, 409, `A placa ${v.plate} já está no pátio (autorização ${dup.auth_code}). Finalize ou cancele antes.`);
  const token = crypto.randomBytes(18).toString('base64url');
  const info = db.prepare(`INSERT INTO visits (auth_code, driver_name, phone, plate, carrier, op_type, cargo, partner, note, driver_token, arrived_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('TMP-' + token.slice(0, 8), v.driver_name, v.phone, v.plate, v.carrier, v.op_type, v.cargo, v.partner, v.note, token, now(), req.op);
  const id = Number(info.lastInsertRowid);
  const code = `${v.op_type === 'RECEBIMENTO' ? 'R' : 'E'}-${String(id).padStart(4, '0')}`;
  db.prepare('UPDATE visits SET auth_code = ? WHERE id = ?').run(code, id);
  logEvent(id, 'CHEGADA_AUTORIZADA', { autorizacao: code, tipo: v.op_type, placa: v.plate }, req.op);
  teamAlert(id, 'NOVA_CHEGADA'); // a tela do Recebimento/Expedição pisca: tem caminhão para chamar
  broadcastVisit(id);
  res.status(201).json({ ...staffView(getVisit(id)), driver_link: `${baseUrl(req)}/m/?t=${token}` });
});

app.get('/api/visits', staff, (req, res) => {
  const scope = req.query.scope || 'active';
  let rows;
  if (scope === 'active') rows = db.prepare(`SELECT * FROM visits WHERE status IN ('AGUARDANDO','CHAMADO','CONFIRMADO','NA_DOCA') ORDER BY arrived_at`).all();
  else {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    const from = new Date(`${day || new Date().toISOString().slice(0, 10)}T00:00:00${CFG.tzOffset}`).toISOString();
    const to = new Date(new Date(from).getTime() + 86400e3).toISOString();
    rows = db.prepare('SELECT * FROM visits WHERE arrived_at >= ? AND arrived_at < ? ORDER BY arrived_at DESC').all(from, to);
  }
  res.json(rows.map(staffView));
});

app.get('/api/visits/:id/qr.svg', staff, async (req, res) => {
  const v = getVisit(Number(req.params.id));
  if (!v) return res.status(404).end();
  const svg = await QRCode.toString(`${baseUrl(req)}/m/?t=${v.driver_token}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});
app.get('/api/visits/:id/link', staff, (req, res) => {
  const v = getVisit(Number(req.params.id));
  if (!v) return bad(res, 404, 'Não encontrado.');
  res.json({ driver_link: `${baseUrl(req)}/m/?t=${v.driver_token}` });
});

app.get('/api/docks', staff, (req, res) => {
  const docks = db.prepare('SELECT * FROM docks ORDER BY sort, name').all();
  const busy = db.prepare(`SELECT dock, COUNT(*) n FROM visits WHERE status IN ('CHAMADO','CONFIRMADO','NA_DOCA') AND dock IS NOT NULL GROUP BY dock`).all();
  const m = Object.fromEntries(busy.map((b) => [b.dock, b.n]));
  res.json(docks.map((d) => ({ ...d, busy: m[d.name] || 0 })));
});

// ---------- Ações da equipe (Recebimento / Expedição) ----------
// Agir sobre o caminhão conta como "ciente" do aviso da equipe.
const markSeen = (id, op) => db.prepare('UPDATE visits SET team_ack_at = ?, team_ack_by = COALESCE(?, team_ack_by), handled_by = ? WHERE id = ?').run(now(), op, op, id);
const onlineCount = (id) => [...clients].filter((c) => c.kind === 'driver' && c.visitId === id).length;
function loadActive(req, res, allowed) {
  const v = getVisit(Number(req.params.id));
  if (!v) { bad(res, 404, 'Visita não encontrada.'); return null; }
  if (!allowed.includes(v.status)) { bad(res, 409, 'A situação deste caminhão mudou. Atualize a tela.'); return null; }
  return v;
}
// Avisa o celular do motorista: página aberta (SSE) + notificação (Web Push, se permitida).
async function ringDriver(v, title, body) {
  emit((c) => c.kind === 'driver' && c.visitId === v.id, 'call', { dock: v.dock, plate: v.plate });
  const push = await pushToVisit(v, { title, body, url: '/m/', tag: `call-${v.id}` });
  return { page_open: onlineCount(v.id) > 0, push };
}

app.post('/api/visits/:id/call', staff, async (req, res) => {
  const v = loadActive(req, res, ['AGUARDANDO', 'CHAMADO', 'CONFIRMADO']); if (!v) return;
  const dock = db.prepare('SELECT name FROM docks WHERE name = ?').get(clean(req.body.dock, 40));
  if (!dock) return bad(res, 400, 'Escolha a doca ou local.');
  db.prepare(`UPDATE visits SET status = 'CHAMADO', dock = ?, called_at = COALESCE(called_at, ?), confirmed_at = NULL, call_count = call_count + 1, called_by = ? WHERE id = ?`)
    .run(dock.name, now(), req.op, v.id);
  markSeen(v.id, req.op);
  const nv = getVisit(v.id);
  const delivery = await ringDriver(nv, `CHAMADA: ${dock.name}`, `Compareça à ${dock.name}. Caminhão ${nv.plate}. Autorização ${nv.auth_code}.`);
  logEvent(v.id, nv.call_count > 1 ? 'RECHAMADA' : 'CHAMADA', { doca: dock.name, ...delivery }, req.op);
  broadcastVisit(v.id);
  res.json({ visit: staffView(getVisit(v.id)), delivery });
});

app.post('/api/visits/:id/recall', staff, async (req, res) => {
  const v = loadActive(req, res, ['CHAMADO', 'CONFIRMADO']); if (!v) return;
  db.prepare(`UPDATE visits SET status = 'CHAMADO', confirmed_at = NULL, call_count = call_count + 1 WHERE id = ?`).run(v.id);
  markSeen(v.id, req.op);
  const nv = getVisit(v.id);
  const delivery = await ringDriver(nv, `CHAMADA REPETIDA: ${nv.dock}`, `Compareça à ${nv.dock}. Caminhão ${nv.plate}.`);
  logEvent(v.id, 'RECHAMADA', { doca: nv.dock, ...delivery }, req.op);
  broadcastVisit(v.id);
  res.json({ visit: staffView(getVisit(v.id)), delivery });
});

app.post('/api/visits/:id/uncall', staff, (req, res) => {
  const v = loadActive(req, res, ['CHAMADO', 'CONFIRMADO']); if (!v) return;
  db.prepare(`UPDATE visits SET status = 'AGUARDANDO', dock = NULL, confirmed_at = NULL WHERE id = ?`).run(v.id);
  markSeen(v.id, req.op);
  logEvent(v.id, 'VOLTOU_PARA_FILA', null, req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

// Motorista confirmado pessoalmente (sem tocar em "estou indo")
app.post('/api/visits/:id/confirm', staff, (req, res) => {
  const v = loadActive(req, res, ['CHAMADO']); if (!v) return;
  db.prepare(`UPDATE visits SET status = 'CONFIRMADO', confirmed_at = ? WHERE id = ?`).run(now(), v.id);
  markSeen(v.id, req.op);
  logEvent(v.id, 'CONFIRMADO_MANUAL', { metodo: clean(req.body.method, 20) || 'PRESENCIAL' }, req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

app.post('/api/visits/:id/docked', staff, (req, res) => {
  const v = loadActive(req, res, ['CHAMADO', 'CONFIRMADO']); if (!v) return;
  const t = now();
  db.prepare(`UPDATE visits SET status = 'NA_DOCA', docked_at = ?, confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?`).run(t, t, v.id);
  markSeen(v.id, req.op);
  logEvent(v.id, 'ENCOSTOU_NA_DOCA', { doca: v.dock }, req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

// Chamar o motorista com o caminhão já na doca (motivo; "MUDAR" troca a doca).
app.post('/api/visits/:id/dock-call', staff, async (req, res) => {
  const v = loadActive(req, res, ['NA_DOCA']); if (!v) return;
  const reason = String(req.body.reason || '');
  if (!REASONS[reason]) return bad(res, 400, 'Escolha o motivo da chamada.');
  let dockName = v.dock;
  if (reason === 'MUDAR') {
    const d = db.prepare('SELECT name FROM docks WHERE name = ?').get(clean(req.body.dock, 40));
    if (!d) return bad(res, 400, 'Escolha a nova doca.');
    dockName = d.name;
  }
  db.prepare(`UPDATE visits SET dock = ?, dock_call_reason = ?, dock_call_at = ?, dock_call_acked_at = NULL, dock_call_count = dock_call_count + 1 WHERE id = ?`)
    .run(dockName, reason, now(), v.id);
  markSeen(v.id, req.op);
  const nv = getVisit(v.id);
  const r = REASONS[reason];
  const delivery = await ringDriver(nv, reason === 'MUDAR' ? `MUDE PARA A ${dockName}` : `${r.head} · ${dockName}`, `${r.text(dockName)} Caminhão ${nv.plate}.`);
  logEvent(v.id, 'CHAMADA_NA_DOCA', { motivo: r.label, doca: dockName, ...delivery }, req.op);
  broadcastVisit(v.id);
  res.json({ visit: staffView(getVisit(v.id)), delivery });
});

app.post('/api/visits/:id/finish', staff, (req, res) => {
  const v = loadActive(req, res, ['NA_DOCA', 'CHAMADO', 'CONFIRMADO']); if (!v) return;
  const t = now();
  db.prepare(`UPDATE visits SET status = 'FINALIZADO', finished_at = ?, closed_at = ? WHERE id = ?`).run(t, t, v.id);
  markSeen(v.id, req.op);
  logEvent(v.id, 'SAIDA_LIBERADA', { doca: v.dock }, req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

app.post('/api/visits/:id/cancel', staff, (req, res) => {
  const v = loadActive(req, res, ACTIVE); if (!v) return;
  db.prepare(`UPDATE visits SET status = 'CANCELADO', closed_at = ?, note = COALESCE(?, note) WHERE id = ?`).run(now(), clean(req.body.note, 200) || null, v.id);
  logEvent(v.id, 'CANCELADO', clean(req.body.note, 200), req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

app.post('/api/visits/:id/team-ack', staff, (req, res) => {
  const v = getVisit(Number(req.params.id));
  if (!v) return bad(res, 404, 'Visita não encontrada.');
  const team = req.body.team === 'EXPEDICAO' ? 'Expedição' : 'Recebimento';
  db.prepare('UPDATE visits SET team_ack_at = ?, team_ack_by = ? WHERE id = ?').run(now(), `${team} · ${req.op}`, v.id);
  logEvent(v.id, 'EQUIPE_CIENTE', { equipe: team, alerta: v.team_alert_kind }, req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

app.get('/api/visits/:id/events', staff, (req, res) => {
  res.json(db.prepare('SELECT * FROM events WHERE visit_id = ? ORDER BY id').all(Number(req.params.id)));
});

// ---------- Indicadores ----------
app.get('/api/stats', staff, (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const from = new Date(`${day || new Date().toISOString().slice(0, 10)}T00:00:00${CFG.tzOffset}`).toISOString();
  const to = new Date(new Date(from).getTime() + 86400e3).toISOString();
  const rows = db.prepare('SELECT * FROM visits WHERE arrived_at >= ? AND arrived_at < ?').all(from, to);
  const mins = (a, b) => (new Date(b) - new Date(a)) / 60000;
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const by = (k) => rows.reduce((o, r) => ((o[r[k]] = (o[r[k]] || 0) + 1), o), {});
  res.json({
    arrivals: rows.length,
    byType: by('op_type'),
    byStatus: by('status'),
    waitingNow: db.prepare(`SELECT COUNT(*) n FROM visits WHERE status = 'AGUARDANDO'`).get().n,
    avgWaitMin: avg(rows.filter((r) => r.called_at).map((r) => mins(r.arrived_at, r.called_at))),
    avgResponseMin: avg(rows.filter((r) => r.confirmed_at && r.called_at).map((r) => mins(r.called_at, r.confirmed_at))),
    avgToDockMin: avg(rows.filter((r) => r.docked_at).map((r) => mins(r.arrived_at, r.docked_at))),
    avgAtDockMin: avg(rows.filter((r) => r.docked_at && r.finished_at).map((r) => mins(r.docked_at, r.finished_at))),
    avgTotalMin: avg(rows.filter((r) => r.finished_at || r.attended_at).map((r) => mins(r.arrived_at, r.finished_at || r.attended_at))),
    dockCalls: rows.reduce((s, r) => s + (r.dock_call_count || 0), 0),
    linkedPct: rows.length ? rows.filter((r) => r.driver_linked_at).length / rows.length : null,
    pushPct: rows.length ? rows.filter((r) => r.push_enabled).length / rows.length : null,
    recalls: rows.reduce((s, r) => s + Math.max(0, r.call_count - 1), 0),
  });
});

app.get('/api/stream', staff, (req, res) => sse(req, res, { kind: 'staff' }));

// ---------- Lado do motorista (público, protegido pelo token da visita) ----------
const byToken = (t) => (t ? db.prepare('SELECT * FROM visits WHERE driver_token = ?').get(String(t)) : null);

app.post('/api/driver/identify', (req, res) => {
  if (limited(req, 'identify', 15)) return bad(res, 429, 'Muitas tentativas. Procure a portaria.');
  const plate = normPlate(req.body.plate);
  const last4 = normPhone(req.body.phone4).slice(-4);
  if (!PLATE.test(plate) || last4.length !== 4) return bad(res, 400, 'Informe a placa e os 4 últimos dígitos do celular cadastrado na portaria.');
  const v = db.prepare(`SELECT * FROM visits WHERE plate = ? AND status IN ('AGUARDANDO','CHAMADO','CONFIRMADO','NA_DOCA') ORDER BY id DESC LIMIT 1`).get(plate);
  if (!v || !v.phone.endsWith(last4)) return bad(res, 404, 'Não encontramos sua entrada. Confira a placa e o celular ou procure a portaria.');
  res.json({ token: v.driver_token });
});

app.get('/api/driver/state', (req, res) => {
  const v = byToken(req.query.t);
  if (!v) return bad(res, 404, 'Link inválido ou expirado.');
  res.json(driverView(v));
});

app.get('/api/driver/stream', (req, res) => {
  const v = byToken(req.query.t);
  if (!v) return res.status(404).end();
  if (!v.driver_linked_at) {
    db.prepare('UPDATE visits SET driver_linked_at = ? WHERE id = ?').run(now(), v.id);
    logEvent(v.id, 'MOTORISTA_CONECTOU', null, 'motorista');
  }
  sse(req, res, { kind: 'driver', visitId: v.id });
  res.write(`event: state\ndata: ${JSON.stringify(driverView(getVisit(v.id)))}\n\n`);
  emit((c) => c.kind === 'staff', 'visit', staffView(getVisit(v.id)));
  req.on('close', () => setTimeout(() => { const o = getVisit(v.id); if (o) emit((c) => c.kind === 'staff', 'visit', staffView(o)); }, 50));
});

app.post('/api/driver/ack', (req, res) => {
  const v = byToken(req.body.token);
  if (!v) return bad(res, 404, 'Link inválido.');
  if (v.status === 'CHAMADO') {
    db.prepare(`UPDATE visits SET status = 'CONFIRMADO', confirmed_at = ? WHERE id = ?`).run(now(), v.id);
    logEvent(v.id, 'MOTORISTA_ESTOU_INDO', { doca: v.dock }, 'motorista');
    teamAlert(v.id, 'ENTRANDO');
  } else if (dockPending(v)) {
    db.prepare('UPDATE visits SET dock_call_acked_at = ? WHERE id = ?').run(now(), v.id);
    logEvent(v.id, 'MOTORISTA_RESPONDEU_NA_DOCA', { motivo: (REASONS[v.dock_call_reason] || {}).label, doca: v.dock }, 'motorista');
    teamAlert(v.id, 'RESPONDEU');
  } else {
    return res.json(driverView(v));
  }
  broadcastVisit(v.id);
  emit((c) => c.kind === 'staff', 'ack', { id: v.id, driver_name: v.driver_name, dock: v.dock, plate: v.plate });
  res.json(driverView(getVisit(v.id)));
});

app.get('/api/push/key', (req, res) => res.json({ publicKey: vapid.publicKey }));
app.post('/api/driver/push-subscribe', (req, res) => {
  const v = byToken(req.body.token);
  const s = req.body.subscription || {};
  if (!v) return bad(res, 404, 'Link inválido.');
  if (!/^https:\/\//.test(s.endpoint || '') || !s.keys || !s.keys.p256dh || !s.keys.auth) return bad(res, 400, 'Inscrição inválida.');
  db.prepare(`INSERT INTO push_subscriptions (visit_id, endpoint, keys, created_at) VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET visit_id = excluded.visit_id, keys = excluded.keys`)
    .run(v.id, s.endpoint, JSON.stringify({ p256dh: s.keys.p256dh, auth: s.keys.auth }), now());
  db.prepare('UPDATE visits SET push_enabled = 1 WHERE id = ?').run(v.id);
  logEvent(v.id, 'NOTIFICACAO_PERMITIDA', null, 'motorista');
  broadcastVisit(v.id);
  res.json({ ok: true });
});

// ---------- QR Code fixo da portaria ----------
app.get('/qr/portaria.svg', async (req, res) => {
  const svg = await QRCode.toString(`${baseUrl(req)}/m/`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.locals.CFG = CFG;
app.locals.db = db;
module.exports = app;
