// Réseau OSM téléchargé par tuiles (~2 km) plutôt qu'en une seule grosse requête :
// - chaque requête Overpass reste petite (rapide, pas de dépassement de délai côté serveur) ;
// - deux à la fois au plus (Overpass limite les places par adresse IP) ;
// - les tuiles proches du départ d'abord ; chaque tuile est gardée en cache (IndexedDB),
//   donc déplacer le départ ou changer la distance ne retélécharge que ce qui manque ;
// - une tuile en échec est retentée seule, sans perdre les autres.
import { fetchOsm, slimOsm } from './osm.js';
import { tileIndex, getTile, putTile } from './cache.js';

const TLAT = 0.02, TLON = 0.03; // ~2,2 km × ~2,2 km en France
const PARALLEL = 2;

/** Tuiles (grille fixe, réutilisable d'une zone à l'autre) couvrant une bbox. */
export function tilesFor(b, [lat0, lon0]) {
  const out = [];
  for (let i = Math.floor(b.s / TLAT); i * TLAT < b.n; i++) {
    for (let j = Math.floor(b.w / TLON); j * TLON < b.e; j++) {
      const t = { id: `${i}_${j}`, s: i * TLAT, n: (i + 1) * TLAT, w: j * TLON, e: (j + 1) * TLON };
      t.d = Math.hypot((t.s + t.n) / 2 - lat0, ((t.w + t.e) / 2 - lon0) * Math.cos(lat0 * Math.PI / 180));
      out.push(t);
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

/**
 * Réseau de la bbox (texte JSON { elements }) assemblé à partir des tuiles.
 * onProgress({ done, total, cached }) ; log(message) pour le diagnostic.
 */
export async function loadOsmTiles(bbox, center, { signal, onProgress, onStatus, log = () => {} } = {}) {
  const tiles = tilesFor(bbox, center);
  const idx = await tileIndex();
  const parts = new Map();
  let cached = 0;
  for (const t of tiles) {
    const hit = await getTile(idx, t.id);
    if (hit) { parts.set(t.id, hit); cached++; }
  }
  const report = () => onProgress?.({ done: parts.size, total: tiles.length, cached });
  report();
  log(`réseau : ${tiles.length} tuiles, ${cached} en cache`);

  const todo = tiles.filter((t) => !parts.has(t.id));
  const failed = [];
  const fetchTile = async (t) => {
    const text = await fetchOsm(t, { signal, timeoutMs: 25000, onStatus, onLog: (m) => log(`tuile ${t.id} : ${m}`) });
    const slim = JSON.stringify(slimOsm(text));
    parts.set(t.id, slim);
    putTile(idx, t.id, slim);
    report();
  };
  const runQueue = async (queue) => {
    const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      while (queue.length) {
        if (signal?.aborted) return;
        const t = queue.shift();
        try { await fetchTile(t); } catch (e) {
          if (e.name === 'AbortError') return;
          failed.push(t);
        }
      }
    });
    await Promise.all(workers);
  };
  await runQueue(todo.slice());
  // Deuxième chance pour les tuiles en échec, une à une.
  if (failed.length && !signal?.aborted) {
    const again = failed.splice(0);
    log(`réseau : ${again.length} tuile(s) en échec, nouvel essai`);
    await runQueue(again);
  }
  if (signal?.aborted) throw new DOMException('Téléchargement annulé', 'AbortError');
  if (failed.length) {
    throw new Error(`Réseau OpenStreetMap incomplet (${parts.size}/${tiles.length} tuiles) : les serveurs ne répondent pas. Réessaie dans un moment ; les tuiles déjà reçues sont gardées.`);
  }

  // Assemblage : une voie à cheval sur plusieurs tuiles n'est gardée qu'une fois.
  const ways = new Map();
  for (const text of parts.values()) {
    for (const el of JSON.parse(text).elements || []) ways.set(el.id, el);
  }
  return { text: JSON.stringify({ elements: [...ways.values()] }), tiles: tiles.length, cached };
}
