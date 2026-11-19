// Service worker : met en cache les tuiles de carte, les tuiles d'altitude et les
// bibliothèques. Les fichiers de l'appli passent d'abord par le réseau (toujours à jour).

const TILES = 'dplus-tiles-v1';
const LIBS = 'dplus-libs-v1';
const MAX_TILES = 3000;

const isTile = (u) => /tiles\.stadiamaps\.com|tile\.openstreetmap\.org|elevation-tiles-prod/.test(u.href);
const isLib = (u) => /unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u.href);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isTile(url)) event.respondWith(cacheFirst(req, TILES, true));
  else if (isLib(url)) event.respondWith(cacheFirst(req, LIBS, false));
  else if (url.origin === self.location.origin) event.respondWith(networkFirst(req));
});

async function cacheFirst(req, name, trim) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    cache.put(req, res.clone()).then(() => trim && trimCache(cache)).catch(() => {});
  }
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(LIBS);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
}

let trimming = false;
async function trimCache(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) {
      for (const k of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(k);
    }
  } finally { trimming = false; }
}
