// Sites online edition: retire only this origin's Infinite Go offline worker.
// Do not touch cookies, saved games, session credentials, or backend data.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      await self.clients.claim();
      const keys = await caches.keys();
      await Promise.all(keys.filter(key => key.startsWith('infinite-go-')).map(key => caches.delete(key)));
    } finally {
      await self.registration.unregister();
    }
  })());
});
// Intentionally no fetch handler: all requests use normal network navigation.
