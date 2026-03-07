const CACHE = 'padelplan-v1';
const ASSETS = [
  '/padel-app/',
  '/padel-app/index.html',
  '/padel-app/match.html',
  '/padel-app/kamp.html',
  '/padel-app/stats.html',
  '/padel-app/style.css',
  '/padel-app/app.js',
  '/padel-app/match.js',
  '/padel-app/kamp.js',
  '/padel-app/stats.js',
  '/padel-app/firebase.js',
  '/padel-app/scheduler.js',
  '/padel-app/icons/icon-192.png',
  '/padel-app/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for Firebase, cache-first for static assets
self.addEventListener('fetch', e => {
  if (e.request.url.includes('firestore') || e.request.url.includes('firebase')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
