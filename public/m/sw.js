/* Service worker do motorista: mostra a chamada como notificação do sistema,
   inclusive com a página fechada ou a tela bloqueada (se o motorista permitiu notificações). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Chamada da portaria', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Chamada da portaria', {
    body: d.body || 'Você foi chamado. Abra para ver a doca.',
    tag: d.tag || 'chamada',
    renotify: true,
    requireInteraction: true,
    vibrate: [800, 250, 800, 250, 800, 250, 1500],
    icon: '/m/icon.svg',
    badge: '/m/icon.svg',
    data: { url: d.url || '/m/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/m/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.includes('/m/') && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
