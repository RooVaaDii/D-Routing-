// Service worker : met en cache les tuiles et polices de carte (OpenFreeMap), les tuiles
// d'altitude (Terrarium) et les polices de l'interface. Les fichiers de l'appli passent
// d'abord par le réseau (toujours à jour).

const TILES = 'dplus-tiles-v2';
const LIBS = 'dplus-libs-v2';
const KEEP = [TILES, LIBS];
const MAX_TILES = 4000;

// Tuiles datées OpenFreeMap (/planet/AAAAMMJJ_…/z/x/y.pbf) et Terrarium : immuables.
const isTile = (u) => (u.host === 'tiles.openfreemap.org' && /\/planet\/[^/]+\/\d+\/\d+\/\d+\.pbf$/.test(u.pathname))
  || /elevation-tiles-prod/.test(u.href);
// Polices de carte (glyphes) et de l'interface : stables.
const isLib = (u) => (u.host === 'tiles.openfreemap.org' && u.pathname.startsWith('/fonts/'))
  || /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(u.host);
// TileJSON / styles OpenFreeMap : changent à chaque mise à jour des tuiles → réseau d'abord.
const isMeta = (u) => u.host === 'tiles.openfreemap.org';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (!KEEP.includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isTile(url)) event.respondWith(cacheFirst(req, TILES, true));
  else if (isLib(url)) event.respondWith(cacheFirst(req, LIBS, false));
  else if (isMeta(url) || url.origin === self.location.origin) event.respondWith(networkFirst(req));
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
