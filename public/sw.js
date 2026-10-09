// Service worker: shows push notifications and lets the app be added to the home screen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// A fetch handler lets phones offer "Add to Home Screen"; requests go straight to the network.
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let msg = { title: 'Friday Soccer', body: 'Open the app for the latest update.' };
    try {
      const sub = await self.registration.pushManager.getSubscription();
      const res = await fetch('/api/latest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub && sub.endpoint }),
      });
      if (res.ok) msg = await res.json();
    } catch {}
    await self.registration.showNotification(msg.title, {
      body: msg.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { c.navigate('/'); return c.focus(); } }
    return self.clients.openWindow('/');
  })());
});
