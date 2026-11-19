// Cache local (IndexedDB) des données lourdes : réseau OSM et grille d'altitude IGN.
// Une zone déjà téléchargée qui couvre la zone demandée est réutilisée, sans réseau.
//
// Robustesse : toute opération a un délai maximal (Safari peut laisser IndexedDB en suspens) ;
// en cas de souci, on continue sans cache. La recherche ne lit que les clés (kind:date:bbox),
// jamais toutes les données, et n'ouvre que la zone retenue.

const DB = 'dplus-cache', STORE = 'areas', VERSION = 1;
const MAX_PER_KIND = 4;
const MAX_AGE = { osm: 14 * 864e5, ign: 90 * 864e5 };
const OPEN_MS = 2500, OP_MS = 6000;

/** Écouteur facultatif : reçoit { op, kind, ms, ok, note } pour chaque opération. */
let listener = () => {};
export function onCacheEvent(fn) { listener = fn || (() => {}); }

const timeout = (p, ms, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} : délai dépassé (${ms} ms)`)), ms)),
]);

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = timeout(new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB indisponible'));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloquée par un autre onglet'));
  }), OPEN_MS, 'ouverture du cache').catch((e) => { dbp = null; throw e; });
  return dbp;
}

function tx(mode, fn) {
  return timeout(open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  })), OP_MS, 'cache');
}

const contains = (a, b) => a.s <= b.s && a.w <= b.w && a.n >= b.n && a.e >= b.e;

/** Clé : kind:date:s,w,n,e (les anciennes clés sans date sont considérées périmées). */
const keyOf = (kind, t, b) => `${kind}:${t}:${b.s},${b.w},${b.n},${b.e}`;
function parseKey(key) {
  const p = String(key).split(':');
  if (p.length !== 3) return { kind: p[0], t: 0, bbox: null, key };
  const [s, w, n, e] = p[2].split(',').map(Number);
  return { kind: p[0], t: +p[1], bbox: { s, w, n, e }, key };
}
const keys = async (kind) => (await tx('readonly', (st) => st.getAllKeys())).map(parseKey).filter((k) => k.kind === kind);

/** Donnée en cache couvrant entièrement la bbox, ou null. */
export async function findCovering(kind, bbox) {
  const t0 = performance.now();
  try {
    const now = Date.now();
    const hit = (await keys(kind))
      .filter((k) => k.bbox && now - k.t < MAX_AGE[kind] && contains(k.bbox, bbox))
      .sort((a, b) => b.t - a.t)[0];
    const row = hit ? await tx('readonly', (st) => st.get(hit.key)) : null;
    listener({ op: 'lecture', kind, ms: performance.now() - t0, ok: true, note: row ? 'trouvé' : 'absent' });
    return row || null;
  } catch (e) {
    listener({ op: 'lecture', kind, ms: performance.now() - t0, ok: false, note: e.message });
    return null;
  }
}

/** Enregistre une zone ; garde seulement les plus récentes (et supprime les clés périmées). */
export async function save(kind, bbox, data) {
  const t0 = performance.now();
  try {
    const t = Date.now();
    await tx('readwrite', (st) => st.put({ key: keyOf(kind, t, bbox), kind, bbox, t, data }));
    const list = (await keys(kind)).sort((a, b) => b.t - a.t);
    const drop = list.filter((k, i) => i >= MAX_PER_KIND || !k.bbox || t - k.t >= MAX_AGE[kind]);
    if (drop.length) await tx('readwrite', (st) => { for (const k of drop) st.delete(k.key); });
    listener({ op: 'écriture', kind, ms: performance.now() - t0, ok: true });
  } catch (e) {
    // Quota, navigation privée ou cache bloqué : on continue sans cache.
    listener({ op: 'écriture', kind, ms: performance.now() - t0, ok: false, note: e.message });
  }
}

// --- Tuiles du réseau OSM -------------------------------------------------------------------
// Une entrée par tuile (clé tile:<tuile>:<date>) : déplacer le départ ou changer la distance ne
// retélécharge que les tuiles manquantes.
const TILE_MAX = 160;
const TILE_AGE = 14 * 864e5;

/** Index des tuiles en cache : Map tuile → { key, t }. */
export async function tileIndex() {
  try {
    const idx = new Map();
    for (const key of await tx('readonly', (st) => st.getAllKeys())) {
      const m = /^tile:(.+):(\d+)$/.exec(String(key));
      if (m) idx.set(m[1], { key, t: +m[2] });
    }
    return idx;
  } catch (e) {
    listener({ op: 'index des tuiles', kind: 'osm', ms: 0, ok: false, note: e.message });
    return new Map();
  }
}

/** Contenu d'une tuile en cache (texte JSON), ou null. */
export async function getTile(idx, tile) {
  const hit = idx.get(tile);
  if (!hit || Date.now() - hit.t > TILE_AGE) return null;
  try { return (await tx('readonly', (st) => st.get(hit.key)))?.data ?? null; } catch { return null; }
}

/** Enregistre une tuile ; ne garde que les plus récentes. */
export async function putTile(idx, tile, data) {
  try {
    const t = Date.now(), key = `tile:${tile}:${t}`;
    const old = idx.get(tile);
    await tx('readwrite', (st) => { st.put({ key, t, data }); if (old) st.delete(old.key); });
    idx.set(tile, { key, t });
    if (idx.size > TILE_MAX) {
      const drop = [...idx.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, idx.size - TILE_MAX);
      await tx('readwrite', (st) => { for (const [, v] of drop) st.delete(v.key); });
      for (const [k] of drop) idx.delete(k);
    }
  } catch (e) {
    listener({ op: 'écriture tuile', kind: 'osm', ms: 0, ok: false, note: e.message });
  }
}
