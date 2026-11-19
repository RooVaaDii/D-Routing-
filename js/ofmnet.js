// Worker : réseau praticable à pied construit à partir des tuiles vectorielles OpenFreeMap
// (couche « transportation » d'OpenMapTiles, zoom 14), au lieu de l'API Overpass.
// Les tuiles sont servies par un CDN rapide et mises en cache par le service worker.
//
// Les tuiles sont simplifiées : des sommets de jonction manquent (une rue s'arrête contre une
// autre sans point commun, deux rues se croisent sans sommet). On recalcule donc la topologie :
// - croisement de deux segments au même niveau (hors ponts / tunnels) → nœud commun ;
// - extrémité libre à moins d'un mètre environ d'un autre segment → raccrochée à ce segment ;
// - rues coupées au bord des tuiles → recollées (tolérance un peu plus large).
// Résultat : des « ways » au format Overpass (nodes, geometry, tags) pour js/graph.js, inchangé.
import Pbf from '../vendor/mvt/pbf.js';
import { VectorTile } from '../vendor/mvt/vector-tile.js';

const Z = 14, EXT = 4096, WORLD = EXT * 2 ** Z;
const PARALLEL = 6;
const TOL = 2;        // raccord d'une extrémité libre (unités de tuile, ~0,8 m à Paris)
const TOL_EDGE = 6;   // raccord au bord d'une tuile
const CELL = 64;      // grille d'index spatial (unités)

let tileUrl = null;

self.onmessage = async (ev) => {
  const { id, bbox } = ev.data;
  try {
    const res = await build(bbox, (done, total) => self.postMessage({ id, type: 'progress', done, total }));
    self.postMessage({ id, type: 'done', ...res });
  } catch (e) {
    self.postMessage({ id, type: 'error', message: e.message || String(e) });
  }
};

const lon2x = (lon) => ((lon + 180) / 360) * WORLD;
const lat2y = (lat) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD; };
const r6 = (v) => Math.round(v * 1e6) / 1e6; // ~10 cm : allège le texte transmis
const x2lon = (x) => (x / WORLD) * 360 - 180;
const y2lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI;

async function tileTemplate() {
  if (tileUrl) return tileUrl;
  const r = await fetch('https://tiles.openfreemap.org/planet');
  if (!r.ok) throw new Error(`OpenFreeMap : HTTP ${r.status}`);
  tileUrl = (await r.json()).tiles[0];
  return tileUrl;
}

async function fetchTile(tpl, x, y) {
  const url = tpl.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 204 || r.status === 404) return null; // rien ici (mer…)
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= 2) throw new Error(`tuile ${x}/${y} : ${e.message}`);
      await new Promise((s) => setTimeout(s, 800 * (attempt + 1)));
    }
  }
}

// --- Étiquettes OpenMapTiles → étiquettes OSM attendues par le graphe -----------------------------
const PATHS = new Set(['footway', 'cycleway', 'steps', 'bridleway', 'path', 'pedestrian']);
function tagsOf(p) {
  if (p.indoor) return null;
  let highway;
  if (p.class === 'path') {
    if (!PATHS.has(p.subclass)) return null; // quais, couloirs, ascenseurs…
    highway = p.subclass;
  } else if (p.class === 'minor') highway = 'residential';
  else if (['primary', 'secondary', 'tertiary', 'service', 'track'].includes(p.class)) highway = p.class;
  else return null; // autoroutes, voies ferrées, chantiers…
  const tags = { highway };
  if (p.surface) tags.surface = p.surface;
  if (p.brunnel === 'bridge') tags.bridge = 'yes';
  if (p.brunnel === 'tunnel') tags.tunnel = 'yes';
  if (p.access) tags.access = p.access;
  if (p.foot) tags.foot = p.foot;
  if (p.service) tags.service = p.service;
  return tags;
}
/** Niveau : seuls les segments d'un même niveau se croisent vraiment. */
const levelOf = (p) => (p.brunnel === 'bridge' || p.brunnel === 'tunnel' ? `${p.brunnel}${p.layer ?? ''}` : `g${p.layer ?? 0}`);

// --- Découpe d'une polyligne au carré de la tuile (Liang-Barsky) -------------------------------------
function clipLine(pts, x0, y0, x1, y1) {
  const out = [];
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (!(clip(-dx, a[0] - x0) && clip(dx, x1 - a[0]) && clip(-dy, a[1] - y0) && clip(dy, y1 - a[1]))) { cur = null; continue; }
    const p = t0 > 0 ? [a[0] + t0 * dx, a[1] + t0 * dy, true] : a;
    const q = t1 < 1 ? [a[0] + t1 * dx, a[1] + t1 * dy, true] : b;
    if (!cur || t0 > 0) { cur = [p]; out.push(cur); }
    cur.push(q);
    if (t1 < 1) cur = null;
  }
  return out.filter((l) => l.length >= 2);
}

async function build(bbox, onProgress) {
  const tpl = await tileTemplate();
  const tx0 = Math.floor(lon2x(bbox.w) / EXT), tx1 = Math.floor(lon2x(bbox.e) / EXT);
  const ty0 = Math.floor(lat2y(bbox.n) / EXT), ty1 = Math.floor(lat2y(bbox.s) / EXT);
  const jobs = [];
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) jobs.push([x, y]);
  const total = jobs.length;
  let done = 0;
  onProgress(0, total);

  const lines = [];   // { pts: [[x, y, edge?]], tags, level }
  const names = [];   // segments nommés : [x0, y0, x1, y1, name]
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (queue.length) {
      const [x, y] = queue.shift();
      const buf = await fetchTile(tpl, x, y);
      if (buf) decodeTile(buf, x, y, lines, names);
      onProgress(++done, total);
    }
  }));
  return nodeAndExport(lines, names, total);
}

function decodeTile(buf, tx, ty, lines, names) {
  const vt = new VectorTile(new Pbf(buf));
  const ox = tx * EXT, oy = ty * EXT;
  const L = vt.layers.transportation;
  for (let i = 0; L && i < L.length; i++) {
    const f = L.feature(i);
    if (f.type !== 2) continue;
    const tags = tagsOf(f.properties);
    if (!tags) continue;
    const level = levelOf(f.properties);
    for (const g of f.loadGeometry()) {
      // Chaque tuile ne garde que sa part (sans le tampon), en coordonnées globales.
      for (const part of clipLine(g.map((p) => [p.x, p.y]), 0, 0, EXT, EXT)) {
        lines.push({ pts: part.map((p) => [ox + p[0], oy + p[1], p[2] === true]), tags, level });
      }
    }
  }
  const N = vt.layers.transportation_name;
  for (let i = 0; N && i < N.length; i++) {
    const f = N.feature(i);
    const name = f.properties.name;
    if (!name || f.type !== 2) continue;
    for (const g of f.loadGeometry()) {
      for (let k = 1; k < g.length; k++) names.push([ox + g[k - 1].x, oy + g[k - 1].y, ox + g[k].x, oy + g[k].y, name]);
    }
  }
}

// --- Topologie ------------------------------------------------------------------------------------------
function nodeAndExport(lines, names, tiles) {
  // Segments indexés dans une grille.
  const segs = []; // [lineIdx, k] : segment k de la ligne
  const grid = new Map();
  const cellKey = (cx, cy) => cx * 1e6 + cy;
  const addToGrid = (s, a, b, pad = 0) => {
    const cx0 = Math.floor((Math.min(a[0], b[0]) - pad) / CELL), cx1 = Math.floor((Math.max(a[0], b[0]) + pad) / CELL);
    const cy0 = Math.floor((Math.min(a[1], b[1]) - pad) / CELL), cy1 = Math.floor((Math.max(a[1], b[1]) + pad) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = cellKey(cx, cy);
      let c = grid.get(k); if (!c) grid.set(k, (c = [])); c.push(s);
    }
  };
  lines.forEach((l, li) => {
    l.splits = l.pts.map(() => []); // points à insérer après le sommet k : [t, x, y]
    for (let k = 1; k < l.pts.length; k++) { const s = segs.length; segs.push([li, k - 1]); addToGrid(s, l.pts[k - 1], l.pts[k]); }
  });
  const near = (x, y, r, fn) => {
    const seen = new Set();
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        for (const s of grid.get(cellKey(cx, cy)) || []) if (!seen.has(s)) { seen.add(s); fn(s); }
      }
    }
  };
  const P = (s) => { const [li, k] = segs[s]; const l = lines[li]; return [l.pts[k], l.pts[k + 1], l, k, li]; };
  const addSplit = (l, k, t, x, y) => { if (t > 1e-6 && t < 1 - 1e-6) l.splits[k].push([t, x, y]); };

  // 1) Croisements au même niveau sans sommet commun.
  for (const cell of grid.values()) {
    for (let i = 0; i < cell.length; i++) {
      const [a, b, la, ka, lia] = P(cell[i]);
      for (let j = i + 1; j < cell.length; j++) {
        const [c, d, lc, kc, lic] = P(cell[j]);
        if (la.level !== lc.level || (lia === lic && Math.abs(ka - kc) <= 1)) continue;
        const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
        if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) continue;
        const x = a[0] + t * rx, y = a[1] + t * ry;
        addSplit(la, ka, t, x, y); addSplit(lc, kc, u, x, y);
      }
    }
  }

  // 2) Extrémités libres posées contre un autre segment (jonction en T perdue, bord de tuile).
  const q = (v) => Math.round(v * 8);
  const vkey = (p) => `${q(p[0])},${q(p[1])}`;
  const used = new Map();
  for (const l of lines) for (const p of l.pts) used.set(vkey(p), (used.get(vkey(p)) || 0) + 1);
  lines.forEach((l, li) => {
    for (const end of [0, l.pts.length - 1]) {
      const p = l.pts[end];
      if (used.get(vkey(p)) > 1) continue;
      const tol = p[2] ? TOL_EDGE : TOL;
      let best = null, bestD = tol;
      near(p[0], p[1], tol, (s) => {
        const [a, b, lo, k, lio] = P(s);
        if (lio === li) return;
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
        const x = a[0] + t * dx, y = a[1] + t * dy, dd = Math.hypot(x - p[0], y - p[1]);
        if (dd < bestD) { bestD = dd; best = [lo, k, t, x, y]; }
      });
      if (!best) continue;
      const [lo, k, t, x, y] = best;
      if (t <= 1e-6) { p[0] = lo.pts[k][0]; p[1] = lo.pts[k][1]; } else if (t >= 1 - 1e-6) { p[0] = lo.pts[k + 1][0]; p[1] = lo.pts[k + 1][1]; } else {
        addSplit(lo, k, t, x, y); p[0] = x; p[1] = y;
      }
    }
  });

  // 3) Noms : segment nommé le plus proche du milieu de chaque ligne.
  const ngrid = new Map();
  names.forEach((s, i) => {
    const cx = Math.floor((s[0] + s[2]) / 2 / CELL), cy = Math.floor((s[1] + s[3]) / 2 / CELL);
    const k = cellKey(cx, cy); let c = ngrid.get(k); if (!c) ngrid.set(k, (c = [])); c.push(i);
  });
  const nameAt = (x, y) => {
    let best = null, bestD = 3;
    for (let cx = Math.floor(x / CELL) - 1; cx <= Math.floor(x / CELL) + 1; cx++) {
      for (let cy = Math.floor(y / CELL) - 1; cy <= Math.floor(y / CELL) + 1; cy++) {
        for (const i of ngrid.get(cellKey(cx, cy)) || []) {
          const [x0, y0, x1, y1, name] = names[i];
          const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
          const t = L2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2)) : 0;
          const d = Math.hypot(x0 + t * dx - x, y0 + t * dy - y);
          if (d < bestD) { bestD = d; best = name; }
        }
      }
    }
    return best;
  };

  // 4) Export au format Overpass : nœuds partagés = mêmes coordonnées (au 1/8 d'unité près).
  const ids = new Map();
  let nextId = 1, wayId = 1;
  const idOf = (x, y) => { const k = `${q(x)},${q(y)}`; let id = ids.get(k); if (!id) ids.set(k, (id = nextId++)); return id; };
  const elements = [];
  for (const l of lines) {
    const seq = [];
    for (let k = 0; k < l.pts.length; k++) {
      seq.push(l.pts[k]);
      if (k < l.pts.length - 1 && l.splits[k].length) for (const [, x, y] of l.splits[k].sort((a, b) => a[0] - b[0])) seq.push([x, y]);
    }
    const nodes = [], geometry = [];
    for (const [x, y] of seq) {
      const id = idOf(x, y);
      if (nodes[nodes.length - 1] === id) continue;
      nodes.push(id); geometry.push({ lat: r6(y2lat(y)), lon: r6(x2lon(x)) });
    }
    if (nodes.length < 2) continue;
    const m = seq[seq.length >> 1], m0 = seq[(seq.length >> 1) - 1] || m;
    const name = nameAt((m[0] + m0[0]) / 2, (m[1] + m0[1]) / 2);
    elements.push({ type: 'way', id: wayId++, nodes, geometry, tags: name ? { ...l.tags, name } : l.tags });
  }
  return { text: JSON.stringify({ elements }), tiles, ways: elements.length };
}
export { build };
