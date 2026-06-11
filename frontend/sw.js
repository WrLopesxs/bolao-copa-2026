/* Service worker do Bolão — recebe as notificações push e abre o site ao tocar. */
'use strict';

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data.json(); }
  catch { d = { title: 'Bolão Copa 2026', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Bolão Copa 2026', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag,               // mesma tag substitui a notificação anterior do jogo
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const w = wins[0];
      if (w) { w.focus(); if (w.navigate) w.navigate(url); return; }
      return self.clients.openWindow(url);
    })
  );
});
