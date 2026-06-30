const CACHE_NAME = 'qs-pro-ai-pwa-v6';

const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css?v=mobile-7',
  '/app.js?v=clean-2',
  '/components/takeoff.js',
  '/components/pricing.js',
  '/components/library.js',
  '/components/advisor.js',
  '/components/proposal.js?v=ve-live-2',
  '/assets/gvd-logo.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});




