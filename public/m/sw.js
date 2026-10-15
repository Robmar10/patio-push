/* Service worker do motorista: mostra a chamada como notificação do sistema, com a página fechada,
   a tela bloqueada ou o motorista em outro aplicativo (se ele permitiu notificações).
   A notificação tem o botão "ESTOU INDO", que confirma sem precisar abrir a página. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const VIBRA = [1000, 300, 1000, 300, 1000, 300, 1000, 300, 2000];

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Chamada da portaria', body: event.data && event.data.text() }; }
  const opts = d.quiet
    ? { body: d.body || '', tag: d.tag || 'chamada', renotify: false, silent: true, icon: '/m/icon.svg', badge: '/m/icon.svg', data: { url: d.url || '/m/' } }
    : {
      body: d.body || 'Você foi chamado. Abra para ver a doca.',
      tag: d.tag || 'chamada',
      renotify: true,
      requireInteraction: true,
      vibrate: VIBRA,
      icon: '/m/icon.svg',
      badge: '/m/icon.svg',
      data: { url: d.url || '/m/', token: d.token || null },
      actions: d.ack && d.token ? [{ action: 'ack', title: '✅ ESTOU INDO' }, { action: 'open', title: 'Ver detalhes' }] : [],
    };
  event.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Chamada da portaria', opts);
    // Página aberta em segundo plano: avisa para atualizar a tela.
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
        const r = await fetch('/api/driver/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: data.token }) });
        if (!r.ok) throw new Error('falha');
        // A confirmação silenciosa chega por push; esta cobre o caso de atraso.
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
