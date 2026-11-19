// Cache local (IndexedDB) des données lourdes : réseau OSM et grille d'altitude IGN.
// Une zone déjà téléchargée qui couvre la zone demandée est réutilisée, sans réseau.

const DB = 'dplus-cache', STORE = 'areas', VERSION = 1;
const MAX_PER_KIND = 4;
const MAX_AGE = { osm: 14 * 864e5, ign: 90 * 864e5 };

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB indisponible'));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => { dbp = null; throw e; });
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const contains = (a, b) => a.s <= b.s && a.w <= b.w && a.n >= b.n && a.e >= b.e;

async function all(kind) {
  const rows = await tx('readonly', (st) => st.getAll());
  return rows.filter((r) => r.kind === kind);
}

/** Donnée en cache couvrant entièrement la bbox, ou null. */
export async function findCovering(kind, bbox) {
  try {
    const now = Date.now();
    const rows = (await all(kind)).filter((r) => now - r.t < MAX_AGE[kind] && contains(r.bbox, bbox));
    rows.sort((a, b) => b.t - a.t);
    return rows[0] || null;
  } catch { return null; }
}

/** Enregistre une zone ; garde seulement les plus récentes. */
export async function save(kind, bbox, data) {
  try {
    await tx('readwrite', (st) => st.put({ key: `${kind}:${bbox.s},${bbox.w},${bbox.n},${bbox.e}`, kind, bbox, t: Date.now(), data }));
    const rows = (await all(kind)).sort((a, b) => b.t - a.t);
    if (rows.length > MAX_PER_KIND) {
      await tx('readwrite', (st) => { for (const r of rows.slice(MAX_PER_KIND)) st.delete(r.key); });
    }
  } catch { /* quota ou navigation privée : on continue sans cache */ }
}
