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

// Envia a notificação para o(s) celular(es) desta visita e guarda o resultado REAL do serviço de push
// (Google/Apple/Mozilla). Inscrição que o serviço recusa de vez (expirada, ou feita com outra chave) é removida
// e a visita deixa de aparecer como "notificação ativa" — a tela mostra a falha em vez de fingir que funciona.
async function pushToVisit(visit, payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE visit_id = ?').all(visit.id);
  let ok = 0; let lastErr = null;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(payload), { TTL: 600, urgency: 'high' });
      ok++;
    } catch (e) {
      const code = e.statusCode || 0;
      const msg = String(e.body || e.message || '').replace(/\s+/g, ' ').slice(0, 160);
      lastErr = `${code || 'rede'} ${msg}`.trim();
      // 404/410: inscrição expirou. 401/403: inscrição feita com outra chave do servidor (nunca vai funcionar).
      if ([401, 403, 404, 410].includes(code)) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      logEvent(visit.id, 'PUSH_FALHOU', { status: code, msg }, 'sistema');
    }
  }
  if (subs.length) {
    if (ok) db.prepare('UPDATE visits SET last_push_ok_at = ?, last_push_error = NULL WHERE id = ?').run(now(), visit.id);
    else db.prepare('UPDATE visits SET last_push_error = ? WHERE id = ?').run(lastErr, visit.id);
    const left = db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE visit_id = ?').get(visit.id).n;
    if (!left) {
      db.prepare('UPDATE visits SET push_enabled = 0 WHERE id = ?').run(visit.id);
      logEvent(visit.id, 'NOTIFICACAO_DESATIVADA', { motivo: lastErr }, 'sistema');
      setImmediate(() => broadcastVisit(visit.id));
    }
  }
  return { subscriptions: subs.length, delivered_to_push_service: ok, error: ok ? null : lastErr };
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
const TEAM = { RECEBIMENTO: 'Recebimento', EXPEDICAO: 'Expedição' };
const otherTeam = (t) => (t === 'RECEBIMENTO' ? 'EXPEDICAO' : 'RECEBIMENTO');
// O que o motorista vai fazer quando for chamado: Recebimento = DESCARREGAR, Expedição = CARREGAR.
const ACTION = { RECEBIMENTO: 'DESCARREGAR', EXPEDICAO: 'CARREGAR' };
const callTexts = (v, repeat) => ({
  title: `${repeat ? 'CHAMADA REPETIDA · ' : ''}${ACTION[v.op_type]} · ${v.dock}`,
  body: `Sua vez de ${ACTION[v.op_type].toLowerCase()}: leve o caminhão ${v.plate} para a ${v.dock}. Autorização ${v.auth_code}.`,
});
// Locais fora das docas para onde a equipe pode chamar o motorista (configurável em PLACES, separados por vírgula).
const OFFICES = env('PLACES', 'ESCRITÓRIO RECEBIMENTO,ESCRITÓRIO EXPEDIÇÃO,PORTARIA')
  .split(',').map((s) => clean(s, 40).toUpperCase()).filter(Boolean);
const QUEUE_AND_DOCK = ['AGUARDANDO', 'NA_DOCA'];
// Motivos de chamada/recado ao motorista. "at": em que situação o motivo faz sentido.
// "place": dock = doca atual; newdock = escolher outra doca; choose = escolher local; optional = local opcional.
const REASONS = {
  CONCLUIDO: { label: 'Carga/descarga concluída', head: 'RETIRE O CAMINHÃO', at: ['NA_DOCA'], place: 'dock', text: (p) => `Carga/descarga concluída. Retire o caminhão da ${p}.` },
  CAMINHAO: { label: 'Comparecer ao caminhão', head: 'VÁ ATÉ O CAMINHÃO', at: ['NA_DOCA'], place: 'dock', text: (p) => `Compareça ao seu caminhão na ${p}.` },
  MUDAR: { label: 'Mudar de doca', head: 'MUDE DE DOCA', at: ['NA_DOCA'], place: 'newdock', text: (p) => `Leve o caminhão para a ${p}.` },
  BUSCAR_NF: { label: 'Buscar nota fiscal', head: 'BUSQUE A NOTA FISCAL', at: QUEUE_AND_DOCK, place: 'choose', text: (p) => `Retire a nota fiscal. Vá até: ${p}.` },
  CANHOTO: { label: 'Assinar canhoto', head: 'ASSINE O CANHOTO', at: QUEUE_AND_DOCK, place: 'choose', text: (p) => `Assine o canhoto da nota fiscal. Vá até: ${p}.` },
  DOCUMENTOS: { label: 'Apresentar documentos', head: 'LEVE OS DOCUMENTOS', at: QUEUE_AND_DOCK, place: 'choose', text: (p) => `Apresente a nota fiscal / documentos. Vá até: ${p}.` },
  OUTRO: { label: 'Outro recado', head: 'RECADO DA EQUIPE', at: QUEUE_AND_DOCK, place: 'optional', text: (p, t) => `${t}${p ? ` Vá até: ${p}.` : ''}` },
};
// Recado/chamada feito com o caminhão na fila ou na doca, ainda sem resposta do motorista.
const msgPending = (v) => QUEUE_AND_DOCK.includes(v.status) && !!v.dock_call_at && (!v.dock_call_acked_at || v.dock_call_acked_at < v.dock_call_at);
function msgView(v) {
  if (!v.dock_call_at) return null;
  const r = REASONS[v.dock_call_reason] || REASONS.OUTRO;
  // recado livre sem local fica sem local; registros antigos (sem local gravado) usam a doca
  const place = v.dock_call_place || (v.dock_call_reason === 'OUTRO' ? '' : v.dock || '');
  let free = v.dock_call_text || '';
  if (free && !/[.!?]$/.test(free)) free += '.';
  return {
    reason: v.dock_call_reason, label: r.label, head: r.head, place, text: r.text(place, free),
    at: v.dock_call_at, acked_at: v.dock_call_acked_at, count: v.dock_call_count, pending: msgPending(v),
  };
}
function queuePosition(v) {
  if (v.status !== 'AGUARDANDO') return 0;
  // posição na fila da própria equipe (Recebimento e Expedição chamam separadamente)
  return db.prepare(`SELECT COUNT(*) n FROM visits WHERE status = 'AGUARDANDO' AND op_type = ? AND COALESCE(queued_at, arrived_at) <= ?`)
    .get(v.op_type, v.queued_at || v.arrived_at).n;
}
// O que o celular do motorista pode ver (sem dados de outros motoristas).
function driverView(v) {
  return {
    first_name: v.driver_name.split(' ')[0], plate: v.plate, op_type: v.op_type, auth_code: v.auth_code,
    status: v.status, dock: v.dock, call_count: v.call_count, called_at: v.called_at, arrived_at: v.arrived_at,
    position: queuePosition(v), push_enabled: !!v.push_enabled,
    team: TEAM[v.op_type], action: ACTION[v.op_type], next_team: v.next_op ? TEAM[v.next_op] : null, leg: v.leg || 1, prev_dock: v.prev_dock || null,
    msg: msgView(v),
    exited: !!v.exited_at,
    push_error: v.push_enabled ? null : v.last_push_error || null,
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
  return { ...rest, driver_online: online, msg: msgView(v) };
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
  // Operação dupla: depois de descarregar no Recebimento, carrega na Expedição (ou o contrário).
  const nextOp = b.next_op === true || b.next_op === 'on' || b.next_op === '1' ? otherTeam(v.op_type) : null;
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
  const t0 = now();
  const info = db.prepare(`INSERT INTO visits (auth_code, driver_name, phone, plate, carrier, op_type, cargo, partner, note, driver_token, arrived_at, queued_at, next_op, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('TMP-' + token.slice(0, 8), v.driver_name, v.phone, v.plate, v.carrier, v.op_type, v.cargo, v.partner, v.note, token, t0, t0, nextOp, req.op);
  const id = Number(info.lastInsertRowid);
  const code = `${v.op_type === 'RECEBIMENTO' ? 'R' : 'E'}-${String(id).padStart(4, '0')}`;
  db.prepare('UPDATE visits SET auth_code = ? WHERE id = ?').run(code, id);
  logEvent(id, 'CHEGADA_AUTORIZADA', { autorizacao: code, tipo: v.op_type, depois: nextOp, placa: v.plate }, req.op);
  teamAlert(id, 'NOVA_CHEGADA'); // a tela do Recebimento/Expedição pisca: tem caminhão para chamar
  broadcastVisit(id);
  res.status(201).json({ ...staffView(getVisit(id)), driver_link: `${baseUrl(req)}/m/?t=${token}` });
});

app.get('/api/visits', staff, (req, res) => {
  const scope = req.query.scope || 'active';
  let rows;
  // "Em aberto" inclui os liberados que ainda não passaram pela portaria (últimas 24 h).
  if (scope === 'active') rows = db.prepare(`SELECT * FROM visits WHERE status IN ('AGUARDANDO','CHAMADO','CONFIRMADO','NA_DOCA')
    OR (status = 'FINALIZADO' AND exited_at IS NULL AND finished_at >= ?) ORDER BY arrived_at`).all(new Date(Date.now() - 86400e3).toISOString());
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

// Configuração para as telas: locais e motivos de chamada (fonte única dos textos).
app.get('/api/config', staff, (req, res) => {
  res.json({
    siteName: CFG.siteName, offices: OFFICES, teams: TEAM,
    reasons: Object.fromEntries(Object.entries(REASONS).map(([k, r]) => [k, { label: r.label, head: r.head, at: r.at, place: r.place }])),
  });
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
// Chamada insistente: a notificação se repete a cada 30 s (até 5 min) enquanto o motorista não responder,
// mesmo com o celular bloqueado ou em outro aplicativo. Para sozinha quando ele toca ESTOU INDO
// (na página ou no botão da própria notificação) ou quando a equipe muda a situação.
// Vigia: se em WATCH_MS a chamada não chegou no celular (ou chegou e ninguém respondeu), a tela da equipe pisca
// com o telefone do motorista para ligar — a equipe fica sabendo na hora em vez de esperar um caminhão que não vem.
const RING_EVERY_MS = Number(process.env.RING_EVERY_MS || 30000);
const RING_MAX = Number(process.env.RING_MAX || 10);
const WATCH_MS = Number(process.env.WATCH_MS || 75000);
const ringers = new Map(); // visitId -> { timer, watch, n, key }
const pendingKey = (v) => (v.status === 'CHAMADO' ? `C:${v.call_count}:${v.dock}` : msgPending(v) ? `M:${v.dock_call_count}:${v.dock_call_at}` : null);
function stopRinging(id) { const r = ringers.get(id); if (r) { clearTimeout(r.timer); clearTimeout(r.watch); ringers.delete(id); } }
const payloadFor = (v, title, body, n) => ({
  title: n > 1 ? `${title} (${n}ª vez)` : title, body, url: '/m/?n=1', tag: `call-${v.id}`, token: v.driver_token, kind: 'call', ack: true,
});
async function ringDriver(v, title, body) {
  stopRinging(v.id);
  const t0 = now();
  db.prepare('UPDATE visits SET last_ring_at = ? WHERE id = ?').run(t0, v.id);
  emit((c) => c.kind === 'driver' && c.visitId === v.id, 'call', { dock: v.dock, plate: v.plate });
  const push = await pushToVisit(v, payloadFor(v, title, body, 1));
  const key = pendingKey(v);
  if (key) {
    const r = { n: 1, key, timer: null, watch: null };
    if (push.subscriptions) {
      const tick = async () => {
        const cur = getVisit(v.id);
        if (!cur || pendingKey(cur) !== r.key || r.n >= RING_MAX) { clearTimeout(r.timer); return; }
        r.n++;
        try { await pushToVisit(cur, payloadFor(cur, title, body, r.n)); } catch { /* segue */ }
        if (ringers.get(v.id) === r) r.timer = setTimeout(tick, RING_EVERY_MS);
      };
      r.timer = setTimeout(tick, RING_EVERY_MS);
    }
    r.watch = setTimeout(() => {
      const cur = getVisit(v.id);
      if (!cur || pendingKey(cur) !== r.key) return;
      const reached = (cur.push_receipt_at && cur.push_receipt_at >= t0) || onlineCount(v.id) > 0;
      const kind = reached ? 'SEM_RESPOSTA' : 'NAO_RECEBEU';
      logEvent(v.id, kind, { segundos: Math.round(WATCH_MS / 1000) }, 'sistema');
      teamAlert(v.id, kind);
      broadcastVisit(v.id);
    }, WATCH_MS);
    ringers.set(v.id, r);
  }
  return { page_open: onlineCount(v.id) > 0, push };
}
// Aviso informativo (sem repetir e sem pedir resposta).
const infoPush = (v, title, body) => pushToVisit(v, { title, body, url: '/m/?n=1', tag: `info-${v.id}`, token: v.driver_token, kind: 'info' }).catch(() => {});

app.post('/api/visits/:id/call', staff, async (req, res) => {
  const v = loadActive(req, res, ['AGUARDANDO', 'CHAMADO', 'CONFIRMADO']); if (!v) return;
  const dock = db.prepare('SELECT name FROM docks WHERE name = ?').get(clean(req.body.dock, 40));
  if (!dock) return bad(res, 400, 'Escolha a doca ou local.');
  // chamar para a doca substitui um recado pendente (o motorista vai para a doca de qualquer jeito)
  db.prepare(`UPDATE visits SET status = 'CHAMADO', dock = ?, called_at = COALESCE(called_at, ?), confirmed_at = NULL, call_count = call_count + 1, called_by = ?,
    dock_call_acked_at = CASE WHEN dock_call_at IS NOT NULL AND (dock_call_acked_at IS NULL OR dock_call_acked_at < dock_call_at) THEN ? ELSE dock_call_acked_at END WHERE id = ?`)
    .run(dock.name, now(), req.op, now(), v.id);
  markSeen(v.id, req.op);
  const nv = getVisit(v.id);
  const ct = callTexts(nv, false);
  const delivery = await ringDriver(nv, ct.title, ct.body);
  logEvent(v.id, nv.call_count > 1 ? 'RECHAMADA' : 'CHAMADA', { doca: dock.name, ...delivery }, req.op);
  broadcastVisit(v.id);
  res.json({ visit: staffView(getVisit(v.id)), delivery });
});

app.post('/api/visits/:id/recall', staff, async (req, res) => {
  const v = loadActive(req, res, ['CHAMADO', 'CONFIRMADO']); if (!v) return;
  db.prepare(`UPDATE visits SET status = 'CHAMADO', confirmed_at = NULL, call_count = call_count + 1 WHERE id = ?`).run(v.id);
  markSeen(v.id, req.op);
  const nv = getVisit(v.id);
  const ct = callTexts(nv, true);
  const delivery = await ringDriver(nv, ct.title, ct.body);
  logEvent(v.id, 'RECHAMADA', { doca: nv.dock, ...delivery }, req.op);
  broadcastVisit(v.id);
  res.json({ visit: staffView(getVisit(v.id)), delivery });
});

app.post('/api/visits/:id/uncall', staff, (req, res) => {
  const v = loadActive(req, res, ['CHAMADO', 'CONFIRMADO']); if (!v) return;
  db.prepare(`UPDATE visits SET status = 'AGUARDANDO', dock = NULL, confirmed_at = NULL WHERE id = ?`).run(v.id);
  stopRinging(v.id);
  markSeen(v.id, req.op);
  logEvent(v.id, 'VOLTOU_PARA_FILA', null, req.op);
  infoPush(v, 'Chamada cancelada', 'Aguarde no pátio: você volta para a fila e será chamado de novo.');
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

// Motorista confirmado pessoalmente (sem tocar em "estou indo")
app.post('/api/visits/:id/confirm', staff, (req, res) => {
  const v = loadActive(req, res, ['CHAMADO']); if (!v) return;
  db.prepare(`UPDATE visits SET status = 'CONFIRMADO', confirmed_at = ? WHERE id = ?`).run(now(), v.id);
  stopRinging(v.id);
  markSeen(v.id, req.op);
  logEvent(v.id, 'CONFIRMADO_MANUAL', { metodo: clean(req.body.method, 20) || 'PRESENCIAL' }, req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

app.post('/api/visits/:id/docked', staff, (req, res) => {
  const v = loadActive(req, res, ['CHAMADO', 'CONFIRMADO']); if (!v) return;
  const t = now();
  db.prepare(`UPDATE visits SET status = 'NA_DOCA', docked_at = ?, confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?`).run(t, t, v.id);
  stopRinging(v.id);
  markSeen(v.id, req.op);
  logEvent(v.id, 'ENCOSTOU_NA_DOCA', { doca: v.dock }, req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

// Chamar o motorista com motivo/recado — na fila (ex.: buscar nota, assinar canhoto) ou na doca
// (carga concluída, ir ao caminhão, mudar de doca...). O celular vibra e insiste até ele responder.
async function messageCall(req, res) {
  const v = loadActive(req, res, QUEUE_AND_DOCK); if (!v) return;
  const reason = String(req.body.reason || '');
  const r = REASONS[reason];
  if (!r) return bad(res, 400, 'Escolha o motivo da chamada.');
  if (!r.at.includes(v.status)) return bad(res, 400, `"${r.label}" só vale com o caminhão ${r.at.includes('NA_DOCA') ? 'na doca' : 'na fila'}.`);
  const text = clean(req.body.text, 120);
  if (reason === 'OUTRO' && text.length < 3) return bad(res, 400, 'Escreva o recado.');
  const docks = db.prepare('SELECT name FROM docks').all().map((d) => d.name);
  const wanted = clean(req.body.place || req.body.dock, 40).toUpperCase();
  let dockName = v.dock; let place = null;
  if (r.place === 'dock') place = v.dock;
  else if (r.place === 'newdock') {
    if (!docks.includes(wanted)) return bad(res, 400, 'Escolha a nova doca.');
    dockName = wanted; place = wanted;
  } else if (wanted) {
    if (!docks.includes(wanted) && !OFFICES.includes(wanted)) return bad(res, 400, 'Local inválido.');
    place = wanted;
  } else if (r.place === 'choose') {
    place = OFFICES.find((o) => o.includes(TEAM[v.op_type].toUpperCase())) || OFFICES[0] || v.dock;
  }
  db.prepare(`UPDATE visits SET dock = ?, dock_call_reason = ?, dock_call_place = ?, dock_call_text = ?, dock_call_at = ?, dock_call_acked_at = NULL,
    dock_call_count = dock_call_count + 1 WHERE id = ?`).run(dockName, reason, place, reason === 'OUTRO' ? text : null, now(), v.id);
  markSeen(v.id, req.op);
  const nv = getVisit(v.id);
  const m = msgView(nv);
  const delivery = await ringDriver(nv, m.place ? `${m.head} · ${m.place}` : m.head, `${m.text} Caminhão ${nv.plate}.`);
  logEvent(v.id, v.status === 'NA_DOCA' ? 'CHAMADA_NA_DOCA' : 'RECADO_NA_FILA', { motivo: r.label, local: m.place, recado: nv.dock_call_text || undefined, ...delivery }, req.op);
  broadcastVisit(v.id);
  res.json({ visit: staffView(getVisit(v.id)), delivery });
}
app.post('/api/visits/:id/message', staff, messageCall);
app.post('/api/visits/:id/dock-call', staff, messageCall); // nome antigo, mantido por compatibilidade

// Passar o caminhão para a outra equipe: descarregou no Recebimento e vai carregar na Expedição (ou o contrário),
// ou a portaria lançou na equipe errada. Ele volta para a fila da outra equipe, que é avisada na tela.
app.post('/api/visits/:id/transfer', staff, async (req, res) => {
  const v = loadActive(req, res, ACTIVE); if (!v) return;
  const to = otherTeam(v.op_type);
  const fromDock = v.status === 'NA_DOCA' ? v.dock : null;
  const mins = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);
  const t = now();
  db.prepare(`UPDATE visits SET op_type = ?, next_op = NULL, leg = leg + 1, status = 'AGUARDANDO', prev_dock = ?, dock = NULL, queued_at = ?,
    called_at = NULL, call_count = 0, confirmed_at = NULL, docked_at = NULL, dock_call_reason = NULL, dock_call_place = NULL, dock_call_text = NULL,
    dock_call_at = NULL, dock_call_acked_at = NULL WHERE id = ?`).run(to, fromDock, t, v.id);
  stopRinging(v.id);
  markSeen(v.id, req.op);
  logEvent(v.id, 'TRANSFERIDO', {
    de: TEAM[v.op_type], para: TEAM[to], doca: fromDock,
    etapa_anterior: { espera_min: mins(v.queued_at || v.arrived_at, v.called_at), na_doca_min: mins(v.docked_at, t), chamadas: v.call_count },
  }, req.op);
  teamAlert(v.id, 'TRANSFERIDO'); // a tela da outra equipe pisca
  const nv = getVisit(v.id);
  infoPush(nv, `AGORA: ${TEAM[to].toUpperCase()}`, fromDock
    ? `${TEAM[v.op_type]} concluído. Libere a ${fromDock} e aguarde no pátio: a ${TEAM[to]} vai chamar você.`
    : `Sua entrada foi passada para a ${TEAM[to]}. Aguarde a chamada.`);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

app.post('/api/visits/:id/finish', staff, (req, res) => {
  const v = loadActive(req, res, ['NA_DOCA', 'CHAMADO', 'CONFIRMADO']); if (!v) return;
  const t = now();
  db.prepare(`UPDATE visits SET status = 'FINALIZADO', finished_at = ?, closed_at = ? WHERE id = ?`).run(t, t, v.id);
  stopRinging(v.id);
  markSeen(v.id, req.op);
  logEvent(v.id, 'SAIDA_LIBERADA', { doca: v.dock, ainda_ia_para: v.next_op ? TEAM[v.next_op] : undefined }, req.op);
  infoPush(v, 'SAÍDA LIBERADA', `Caminhão ${v.plate} liberado. Apresente-se na portaria para sair.`);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

app.post('/api/visits/:id/cancel', staff, (req, res) => {
  const v = loadActive(req, res, ACTIVE); if (!v) return;
  db.prepare(`UPDATE visits SET status = 'CANCELADO', closed_at = ?, note = COALESCE(?, note) WHERE id = ?`).run(now(), clean(req.body.note, 200) || null, v.id);
  stopRinging(v.id);
  logEvent(v.id, 'CANCELADO', clean(req.body.note, 200), req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

// Portaria registra que o caminhão liberado passou pela saída: fecha o tempo total no pátio.
app.post('/api/visits/:id/exit', staff, (req, res) => {
  const v = getVisit(Number(req.params.id));
  if (!v) return bad(res, 404, 'Visita não encontrada.');
  if (v.status !== 'FINALIZADO') return bad(res, 409, 'A saída só pode ser registrada depois que a equipe liberar o caminhão.');
  if (v.exited_at) return bad(res, 409, 'Saída já registrada.');
  db.prepare('UPDATE visits SET exited_at = ?, exited_by = ? WHERE id = ?').run(now(), req.op, v.id);
  logEvent(v.id, 'SAIU_PELA_PORTARIA', null, req.op);
  broadcastVisit(v.id);
  res.json(staffView(getVisit(v.id)));
});

// Teste de aviso disparado pela portaria (com o motorista ainda na guarita): ele bloqueia o celular e
// a portaria vê na tela se a notificação chegou ("✔ teste recebido").
app.post('/api/visits/:id/test-push', staff, async (req, res) => {
  const v = getVisit(Number(req.params.id));
  if (!v) return bad(res, 404, 'Visita não encontrada.');
  const n = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE visit_id = ?').get(v.id).n;
  if (!n) return bad(res, 409, 'O celular ainda não ativou as notificações. Peça ao motorista para tocar em ATIVAR ALERTAS e em PERMITIR.');
  const delay = Math.max(0, Math.min(15, Number(req.body.seconds ?? 8))) * 1000;
  setTimeout(() => sendTest(v), delay);
  logEvent(v.id, 'TESTE_DE_AVISO', { por: 'portaria' }, req.op);
  res.json({ ok: true, seconds: delay / 1000 });
});
const sendTest = (v) => pushToVisit(v, {
  title: 'TESTE: aviso funcionando ✔', body: 'É assim que a chamada vai chegar, mesmo com o celular bloqueado.',
  url: '/m/?n=1', tag: `test-${v.id}`, token: v.driver_token, kind: 'test',
}).catch(() => {});

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
    avgWaitMin: avg(rows.filter((r) => r.called_at).map((r) => mins(r.queued_at || r.arrived_at, r.called_at))),
    avgResponseMin: avg(rows.filter((r) => r.confirmed_at && r.called_at).map((r) => mins(r.called_at, r.confirmed_at))),
    avgToDockMin: avg(rows.filter((r) => r.docked_at).map((r) => mins(r.queued_at || r.arrived_at, r.docked_at))),
    avgYardMin: avg(rows.filter((r) => r.exited_at).map((r) => mins(r.arrived_at, r.exited_at))),
    awaitingExit: rows.filter((r) => r.status === 'FINALIZADO' && !r.exited_at).length,
    transfers: rows.filter((r) => (r.leg || 1) > 1).length,
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
  } else if (msgPending(v)) {
    db.prepare('UPDATE visits SET dock_call_acked_at = ? WHERE id = ?').run(now(), v.id);
    const m = msgView(v);
    logEvent(v.id, v.status === 'NA_DOCA' ? 'MOTORISTA_RESPONDEU_NA_DOCA' : 'MOTORISTA_RESPONDEU_RECADO', { motivo: m.label, local: m.place }, 'motorista');
    teamAlert(v.id, 'RESPONDEU');
  } else {
    return res.json(driverView(v));
  }
  stopRinging(v.id);
  // Troca a notificação insistente por uma confirmação silenciosa (some do bloqueio de tela).
  pushToVisit(v, { title: 'Confirmado ✔', body: 'A equipe já sabe que você está indo.', url: '/m/?n=1', tag: `call-${v.id}`, quiet: true }).catch(() => {});
  broadcastVisit(v.id);
  emit((c) => c.kind === 'staff', 'ack', { id: v.id, driver_name: v.driver_name, dock: v.dock, plate: v.plate });
  res.json(driverView(getVisit(v.id)));
});

// Teste: o motorista toca "TESTAR AVISO", bloqueia o celular e recebe uma notificação 10 s depois.
app.post('/api/driver/test-push', (req, res) => {
  const v = byToken(req.body.token);
  if (!v) return bad(res, 404, 'Link inválido.');
  if (limited(req, 'testpush', 6)) return bad(res, 429, 'Aguarde alguns minutos para testar de novo.');
  const n = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE visit_id = ?').get(v.id).n;
  if (!n) return bad(res, 409, 'Notificações não estão ativadas neste celular.');
  setTimeout(() => sendTest(v), 10000);
  logEvent(v.id, 'TESTE_DE_AVISO', null, 'motorista');
  res.json({ ok: true, seconds: 10 });
});

// O service worker do celular avisa quando a notificação CHEGOU no aparelho. É a única forma de saber que
// a chamada foi entregue de verdade (o "enviado" do serviço de push não garante que chegou no celular).
app.post('/api/driver/receipt', (req, res) => {
  const v = byToken(req.body.token);
  if (!v) return bad(res, 404, 'Link inválido.');
  const tag = clean(req.body.tag, 40);
  const t = now();
  if (tag.startsWith('test-')) {
    db.prepare('UPDATE visits SET test_ok_at = ?, push_receipt_at = ? WHERE id = ?').run(t, t, v.id);
    logEvent(v.id, 'TESTE_RECEBIDO_NO_CELULAR', null, 'motorista');
    emit((c) => c.kind === 'staff', 'test_ok', { id: v.id, plate: v.plate, at: t });
  } else {
    const first = !v.push_receipt_at || !v.last_ring_at || v.push_receipt_at < v.last_ring_at;
    db.prepare('UPDATE visits SET push_receipt_at = ? WHERE id = ?').run(t, v.id);
    if (first && tag.startsWith('call-')) logEvent(v.id, 'NOTIFICACAO_CHEGOU_NO_CELULAR', null, 'motorista');
  }
  broadcastVisit(v.id);
  res.json({ ok: true });
});

// Manifesto do "app" do motorista com o acesso dele embutido: no iPhone, o ícone da Tela de Início
// abre com armazenamento separado do Safari — sem isso, o motorista teria de se identificar de novo.
app.get('/m/manifest.webmanifest', (req, res) => {
  const t = /^[A-Za-z0-9_-]{10,64}$/.test(String(req.query.t || '')) ? String(req.query.t) : '';
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
    name: 'Chamada do Motorista', short_name: 'Chamada', start_url: t ? `/m/?t=${t}` : '/m/', scope: '/m/', display: 'standalone',
    background_color: '#f1f3f6', theme_color: '#10151c', icons: [{ src: '/m/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }));
});

app.get('/api/push/key', (req, res) => res.json({ publicKey: vapid.publicKey }));
app.post('/api/driver/push-subscribe', (req, res) => {
  const v = byToken(req.body.token);
  const s = req.body.subscription || {};
  if (!v) return bad(res, 404, 'Link inválido.');
  if (!/^https:\/\//.test(s.endpoint || '') || !s.keys || !s.keys.p256dh || !s.keys.auth) return bad(res, 400, 'Inscrição inválida.');
  const known = db.prepare('SELECT visit_id FROM push_subscriptions WHERE endpoint = ?').get(s.endpoint);
  db.prepare(`INSERT INTO push_subscriptions (visit_id, endpoint, keys, created_at) VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET visit_id = excluded.visit_id, keys = excluded.keys`)
    .run(v.id, s.endpoint, JSON.stringify({ p256dh: s.keys.p256dh, auth: s.keys.auth }), now());
  db.prepare('UPDATE visits SET last_push_error = NULL WHERE id = ?').run(v.id);
  if (!v.push_enabled || !known || known.visit_id !== v.id) {
    db.prepare('UPDATE visits SET push_enabled = 1 WHERE id = ?').run(v.id);
    logEvent(v.id, 'NOTIFICACAO_PERMITIDA', null, 'motorista');
    broadcastVisit(v.id);
  }
  res.json({ ok: true });
});

// ---------- QR Code fixo da portaria ----------
app.get('/qr/portaria.svg', async (req, res) => {
  const svg = await QRCode.toString(`${baseUrl(req)}/m/`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

// Sempre confere se há versão nova (evita o celular ficar com página antiga depois de uma atualização).
app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'],
  setHeaders: (res, file) => { if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.locals.CFG = CFG;
app.locals.db = db;
module.exports = app;
