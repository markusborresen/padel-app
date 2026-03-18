const VERSION = 'padelplan-v5';
const ASSETS = [
  '/padel-app/',
  '/padel-app/index.html',
  '/padel-app/match.html',
  '/padel-app/stats.html',
  '/padel-app/americano-stats.html',
  '/padel-app/admin.html',
  '/padel-app/style.css',
  '/padel-app/app.js',
  '/padel-app/match.js',
  '/padel-app/stats.js',
  '/padel-app/americano-stats.js',
  '/padel-app/admin.js',
  '/padel-app/firebase.js',
  '/padel-app/scheduler.js',
  '/padel-app/icons/icon-192.png',
  '/padel-app/icons/icon-512.png',
];

// Install: pre-cache all app files and activate immediately
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(ASSETS))
  );
});

// Activate: delete ALL old caches, then take control of open pages
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first: always try network for fresh content, fall back to cache offline.
// Skip Firebase/gstatic requests (handled natively).
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (url.includes('firestore') || url.includes('firebase') || url.includes('gstatic')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Store fresh response in cache for offline use
        const clone = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
