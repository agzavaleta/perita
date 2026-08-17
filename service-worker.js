// Perita service worker — cache-first app shell, with network-and-cache-update
// for everything else, and offline fallback to the cached index.html.
//
// Bump CACHE_NAME on each release to invalidate old caches; the app's
// "update available" modal (Perita.jsx / Settings) already handles prompting
// the user and calling skipWaiting() via postMessage — see the message
// listener at the bottom of this file.
const CACHE_NAME = 'perita-v111-shell-v1';
const LEGACY_RECOVERY_CACHE = 'perita-v110-shell-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/perita-contracts.js',
  '/perita-indexeddb.js',
  '/perita-domain.js',
  '/perita-runtime.js',
  '/perita-integrity.js',
  '/perita-legacy.js',
  '/perita-domain-commands.js',
  '/perita-backup.js',
  '/perita-migration.js',
  '/perita-app.js',
  '/icons/apple-touch-icon.png',
  '/icons/icon-152x152.png',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => caches.keys())
      .then((keys) => {
        // One-release bridge: V1.1.0 cannot accept its waiting replacement.
        // Activate only when that legacy shell is actually controlling storage;
        // normal V1.1.1+ updates keep waiting for explicit user acceptance.
        if (keys.includes(LEGACY_RECOVERY_CACHE)) return self.skipWaiting();
        return undefined;
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached || caches.match('/index.html'));
      return cached || networkFetch;
    })
  );
});

// Allows the page to trigger an immediate update once the user confirms the
// "new version available" prompt, instead of waiting for all tabs to close.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
