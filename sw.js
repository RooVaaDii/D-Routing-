// Service worker : met en cache les tuiles et polices de carte (OpenFreeMap), les tuiles
// d'altitude (Terrarium), MapLibre et l'appli.
// - tuiles, polices, MapLibre : cache d'abord (contenus immuables) ;
// - fichiers de l'appli et TileJSON : réseau d'abord, mais pas plus de 3 s avant de servir le cache.
// Il tient des compteurs (cache / réseau) que la page peut demander (message « stats »).

const TILES = 'dplus-tiles-v2';
const FONTS = 'dplus-fonts-v2';
const VENDOR = 'dplus-vendor-maplibre-6.11.2';
const APP = 'dplus-app-v3';
const KEEP = [TILES, FONTS, VENDOR, APP];
const MAX_TILES = 4000;
const NET_MS = 3000;

// Tuiles datées OpenFreeMap (/planet/AAAAMMJJ_…/z/x/y.pbf) et Terrarium : immuables.
const isTile = (u) => (u.host === 'tiles.openfreemap.org' && /\/planet\/[^/]+\/\d+\/\d+\/\d+\.pbf$/.test(u.pathname))
  || u.host === 's3.amazonaws.com' && u.pathname.startsWith('/elevation-tiles-prod/');
// Polices de carte (glyphes) et de l'interface : stables.
const isFont = (u) => (u.host === 'tiles.openfreemap.org' && u.pathname.startsWith('/fonts/'))
  || u.host === 'fonts.googleapis.com' || u.host === 'fonts.gstatic.com';
const isVendor = (u) => u.origin === self.location.origin && u.pathname.includes('/vendor/');
// TileJSON OpenFreeMap : change à chaque mise à jour des tuiles.
const isMeta = (u) => u.host === 'tiles.openfreemap.org';

const stats = { tiles: { cache: 0, net: 0, err: 0 }, fonts: { cache: 0, net: 0, err: 0 }, app: { cache: 0, net: 0, err: 0 } };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (!KEEP.includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('message', (e) => {
  if (e.data?.type !== 'stats' || !e.ports[0]) return;
  (async () => {
    const sizes = {};
    for (const name of KEEP) sizes[name] = (await (await caches.open(name)).keys()).length;
    e.ports[0].postMessage({ stats, sizes });
  })();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isTile(url)) event.respondWith(cacheFirst(req, TILES, stats.tiles, true));
  else if (isFont(url)) event.respondWith(cacheFirst(req, FONTS, stats.fonts, false));
  else if (isVendor(url)) event.respondWith(cacheFirst(req, VENDOR, stats.app, false));
  else if (isMeta(url) || url.origin === self.location.origin) event.respondWith(networkFirst(req, APP, stats.app));
});

async function cacheFirst(req, name, st, trim) {
  const cache = await caches.open(name);
  const hit = await cache.match(req.url);
  if (hit) { st.cache++; return hit; }
  try {
    // Requête détachée du signal d'annulation de la carte : une tuile commencée finit en cache.
    const res = await fetch(req.url, { mode: req.mode === 'navigate' ? 'same-origin' : 'cors', credentials: 'omit' });
    st.net++;
    if (res.ok) cache.put(req.url, res.clone()).then(() => trim && trimCache(cache)).catch(() => {});
    return res;
  } catch (e) {
    st.err++;
    throw e;
  }
}

async function networkFirst(req, name, st) {
  const cache = await caches.open(name);
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  // Réseau lent : on sert la copie en cache après NET_MS (le réseau la met à jour ensuite).
  const slow = new Promise((resolve) => setTimeout(resolve, NET_MS)).then(() => cache.match(req));
  try {
    const fromNet = net.then((r) => ({ r, src: 'net' }));
    const { r, src } = await Promise.race([fromNet, slow.then((hit) => (hit ? { r: hit, src: 'cache' } : fromNet))]);
    st[src]++;
    return r;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) { st.cache++; return hit; }
    st.err++;
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
