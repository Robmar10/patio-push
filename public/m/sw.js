/* Service worker do motorista: mostra a chamada como notificação do sistema, com a página fechada,
   a tela bloqueada ou o motorista em outro aplicativo (se ele permitiu notificações).
   - Avisa o servidor que a notificação CHEGOU no celular (a equipe vê "📳 chegou no celular").
   - A notificação tem o botão "ESTOU INDO", que confirma sem precisar abrir a página.
   - Se o navegador trocar a inscrição de push, inscreve de novo sozinho. */
const VERSION = '3';
const VIBRA = [1000, 300, 1000, 300, 1000, 300, 1000, 300, 2000];
const STORE = 'pp-driver';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// A página informa o acesso (token) do motorista; guardado para reinscrever o push se precisar.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'token' && e.data.token) {
    e.waitUntil(caches.open(STORE).then((c) => c.put('/token', new Response(String(e.data.token)))));
  }
});
const savedToken = async () => { try { const r = await (await caches.open(STORE)).match('/token'); return r ? r.text() : null; } catch { return null; } };

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Chamada da portaria', body: event.data && event.data.text() }; }
  const base = { icon: '/m/icon.svg', badge: '/m/icon.svg', tag: d.tag || 'chamada' };
  let opts;
  if (d.quiet) {
    opts = { ...base, body: d.body || '', renotify: false, silent: true, data: { url: '/m/' } };
  } else if (d.kind === 'info' || d.kind === 'test') {
    opts = { ...base, body: d.body || '', renotify: true, vibrate: [600, 200, 600], data: { url: '/m/' } };
  } else {
    opts = {
      ...base,
      body: d.body || 'Você foi chamado. Abra para ver o local.',
      renotify: true,
      requireInteraction: true,
      vibrate: VIBRA,
      data: { url: '/m/', token: d.token || null },
      actions: d.ack && d.token ? [{ action: 'ack', title: '✅ ESTOU INDO' }, { action: 'open', title: 'Ver detalhes' }] : [],
    };
  }
  event.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Chamada da portaria', opts);
    // Confirma ao servidor que chegou no aparelho (não bloqueia a notificação se falhar).
    if (d.token && !d.quiet) { try { await post('/api/driver/receipt', { token: d.token, tag: d.tag || '' }); } catch { /* sem internet */ } }
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach((c) => c.postMessage({ type: 'push', quiet: !!d.quiet }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  if (event.action === 'ack' && data.token) {
    event.waitUntil((async () => {
      try {
        const r = await post('/api/driver/ack', { token: data.token });
        if (!r.ok) throw new Error('falha');
        await self.registration.showNotification('Confirmado ✔', { body: 'A equipe já sabe que você está indo.', tag: n.tag, silent: true, icon: '/m/icon.svg', data: { url: '/m/' } });
      } catch {
        await self.registration.showNotification('Não foi possível confirmar', { body: 'Sem internet? Toque aqui para abrir e tentar de novo.', tag: n.tag, requireInteraction: true, icon: '/m/icon.svg', data: { url: '/m/' } });
      }
    })());
    return;
  }
  const url = data.url || '/m/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.includes('/m/') && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});

// O navegador pode renovar a inscrição de push; sem isto o motorista pararia de receber em silêncio.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const token = await savedToken();
    if (!token) return;
    let sub = event.newSubscription;
    if (!sub) {
      const { publicKey } = await (await fetch('/api/push/key')).json();
      const pad = '='.repeat((4 - (publicKey.length % 4)) % 4);
      const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
    }
    await post('/api/driver/push-subscribe', { token, subscription: sub.toJSON() });
  })().catch(() => {}));
});
