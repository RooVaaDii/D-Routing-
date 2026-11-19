// Construction du graphe piéton à partir des voies OSM, avec altitudes.

import { haversine, makeProjection } from './geo.js';

// Classes de voies
export const HW = {
  MAJOR: 0,     // primary
  SECONDARY: 1,
  TERTIARY: 2,
  MINOR: 3,     // residential, unclassified, service, road
  PEDESTRIAN: 4,
  TRACK: 5,
  PATH: 6,      // path, footway, bridleway, cycleway
  STEPS: 7,
};

const HW_CLASS = {
  primary: HW.MAJOR, primary_link: HW.MAJOR,
  secondary: HW.SECONDARY, secondary_link: HW.SECONDARY,
  tertiary: HW.TERTIARY, tertiary_link: HW.TERTIARY,
  unclassified: HW.MINOR, residential: HW.MINOR, service: HW.MINOR, road: HW.MINOR,
  living_street: HW.PEDESTRIAN, pedestrian: HW.PEDESTRIAN,
  track: HW.TRACK,
  path: HW.PATH, footway: HW.PATH, bridleway: HW.PATH, cycleway: HW.PATH,
  steps: HW.STEPS,
};

const PAVED = new Set(['paved', 'asphalt', 'concrete', 'concrete:plates', 'concrete:lanes',
  'paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone', 'metal', 'wood', 'chipseal',
  'bricks', 'tartan', 'artificial_turf', 'rubber']);
const UNPAVED = new Set(['unpaved', 'gravel', 'fine_gravel', 'dirt', 'ground', 'earth', 'grass',
  'mud', 'sand', 'compacted', 'pebblestone', 'rock', 'woodchips', 'grass_paver', 'stone', 'soil']);

export const SURF = { PAVED: 0, UNPAVED: 1 };

export function surfaceOf(tags) {
  const s = (tags.surface || '').split(';')[0];
  if (PAVED.has(s)) return SURF.PAVED;
  if (UNPAVED.has(s)) return SURF.UNPAVED;
  const hw = tags.highway;
  if (hw === 'track') return tags.tracktype === 'grade1' ? SURF.PAVED : SURF.UNPAVED;
  if (hw === 'path' || hw === 'bridleway') return SURF.UNPAVED;
  if (hw === 'footway' && (tags.footway === undefined) && tags.lit !== 'yes' && !tags.name) {
    // Sentier piéton sans indication : souvent un chemin en dehors des villes.
    return tags.sac_scale ? SURF.UNPAVED : SURF.PAVED;
  }
  return SURF.PAVED;
}

function isUsable(tags) {
  const hw = tags.highway;
  if (!(hw in HW_CLASS)) return false;
  if (tags.area === 'yes') return false;
  const foot = tags.foot;
  if (foot === 'no' || foot === 'private') return false;
  const access = tags.access;
  if ((access === 'private' || access === 'no') &&
    !(foot === 'yes' || foot === 'designated' || foot === 'permissive')) return false;
  if (hw === 'service' && /^(parking_aisle|driveway|drive-through)$/.test(tags.service || '')) return false;
  // Sentiers alpins difficiles exclus (course à pied).
  if (/^(demanding_alpine_hiking|difficult_alpine_hiking)$/.test(tags.sac_scale || '')) return false;
  if (tags.highway === 'path' && /^(horrible|very_horrible|impassable)$/.test(tags.smoothness || '')) return false;
  return true;
}

const SAMPLE_STEP = 15; // m

/** Dénivelés positif et négatif d'une série d'altitudes (lissage léger sur 3 points). */
export function gainLoss(eles, from = 0, to = eles.length) {
  const n = to - from;
  let up = 0, down = 0;
  if (n < 2) return [0, 0];
  let prev = eles[from];
  for (let i = from + 1; i < to; i++) {
    let e;
    if (i < to - 1 && n >= 4) e = (eles[i - 1] + eles[i] + eles[i + 1]) / 3;
    else e = eles[i];
    const d = e - prev;
    if (d > 0) up += d; else down -= d;
    prev = e;
  }
  return [up, down];
}

/**
 * D+ / D- « honnêtes » avec seuil d'hystérésis : une variation n'est comptée
 * qu'une fois confirmée de plus de `th` mètres (comme une montre GPS).
 * Renvoie aussi la liste des montées (gains) pour juger de leur taille.
 */
export function climbProfile(eles, th = 5) {
  const n = eles.length;
  const climbs = [];
  let up = 0, down = 0;
  if (n < 2) return { up, down, climbs };
  let lo = eles[0], hi = eles[0], base = eles[0], peak = eles[0], trend = 0;
  for (let i = 1; i < n; i++) {
    const e = eles[i];
    if (trend === 0) {
      if (e < lo) lo = e;
      if (e > hi) hi = e;
      if (e - lo >= th) { trend = 1; base = lo; peak = e; }
      else if (hi - e >= th) { trend = -1; base = hi; peak = e; }
    } else if (trend === 1) {
      if (e > peak) peak = e;
      else if (peak - e >= th) {
        climbs.push(peak - base); up += peak - base;
        base = peak; peak = e; trend = -1;
      }
    } else {
      if (e < peak) peak = e;
      else if (e - peak >= th) {
        down += base - peak;
        base = peak; peak = e; trend = 1;
      }
    }
  }
  if (trend === 1) { climbs.push(peak - base); up += peak - base; }
  else if (trend === -1) down += base - peak;
  return { up, down, climbs };
}

/** Valeur « sportive » des montées : < 6 m ne compte pas, ≥ 25 m compte pleinement. */
export function climbQuality(climbs) {
  let q = 0;
  for (const g of climbs) q += g * Math.min(1, Math.max(0, (g - 6) / 19));
  return q;
}

class Grow {
  constructor(Type, n = 1 << 16) { this.T = Type; this.a = new Type(n); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}

/**
 * elements : tableau d'objets « way » d'Overpass (avec nodes + geometry).
 * elevAt(lat, lon) : altitude en m.
 */
export function buildGraph(elements, elevAt, center) {
  const ways = [];
  const seen = new Set();
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || !el.nodes || seen.has(el.id)) continue;
    if (!el.tags || !isUsable(el.tags)) continue;
    // « out geom » peut contenir des null pour les nœuds hors bbox
    if (el.geometry.some((g) => !g)) continue;
    seen.add(el.id);
    ways.push(el);
  }

  // Nœuds de graphe : extrémités de voies et nœuds partagés.
  const use = new Map();
  for (const w of ways) {
    const ns = w.nodes;
    for (let i = 0; i < ns.length; i++) {
      const inc = i === 0 || i === ns.length - 1 ? 2 : 1;
      use.set(ns[i], (use.get(ns[i]) || 0) + inc);
    }
  }
  const index = new Map();
  const nLat = [], nLon = [];
  for (const w of ways) {
    for (let i = 0; i < w.nodes.length; i++) {
      const id = w.nodes[i];
      if (use.get(id) >= 2 && !index.has(id)) {
        index.set(id, nLat.length);
        nLat.push(w.geometry[i].lat);
        nLon.push(w.geometry[i].lon);
      }
    }
  }
  const N = nLat.length;
  const proj = makeProjection(center[0], center[1]);
  const lat = Float64Array.from(nLat), lon = Float64Array.from(nLon);
  const x = new Float32Array(N), y = new Float32Array(N), elev = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const [px, py] = proj.toXY(lat[i], lon[i]);
    x[i] = px; y[i] = py;
    elev[i] = elevAt(lat[i], lon[i]);
  }

  // Arêtes
  const eU = new Grow(Int32Array), eV = new Grow(Int32Array), eLen = new Grow(Float32Array);
  const eUp = new Grow(Float32Array), eDown = new Grow(Float32Array);
  const eHw = new Grow(Uint8Array), eSurf = new Grow(Uint8Array);
  const eS0 = new Grow(Int32Array), eSn = new Grow(Int32Array);
  const sLat = new Grow(Float64Array, 1 << 18), sLon = new Grow(Float64Array, 1 << 18);
  const sEle = new Grow(Float32Array, 1 << 18);

  const tmpLat = [], tmpLon = [], tmpEle = [];
  for (const w of ways) {
    const t = w.tags;
    const hw = HW_CLASS[t.highway];
    const surf = surfaceOf(t);
    // Ponts et tunnels : le MNT donne l'altitude du fond de vallée ou du relief,
    // on interpole donc linéairement entre les deux extrémités.
    const flat = (!!t.bridge && t.bridge !== 'no') || (!!t.tunnel && t.tunnel !== 'no');
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (!index.has(w.nodes[i])) continue;
      const u = index.get(w.nodes[start]), v = index.get(w.nodes[i]);
      // Rééchantillonnage tous les ~15 m le long de la géométrie
      tmpLat.length = 0; tmpLon.length = 0; tmpEle.length = 0;
      let len = 0;
      tmpLat.push(w.geometry[start].lat); tmpLon.push(w.geometry[start].lon);
      for (let k = start + 1; k <= i; k++) {
        const a = w.geometry[k - 1], b = w.geometry[k];
        const d = haversine(a.lat, a.lon, b.lat, b.lon);
        const steps = Math.max(1, Math.round(d / SAMPLE_STEP));
        for (let s = 1; s <= steps; s++) {
          const f = s / steps;
          tmpLat.push(a.lat + (b.lat - a.lat) * f);
          tmpLon.push(a.lon + (b.lon - a.lon) * f);
        }
        len += d;
      }
      if (len < 0.5 && u === v) { start = i; continue; }
      const m = tmpLat.length;
      if (flat) {
        const e0 = elev[u], e1 = elev[v];
        for (let s = 0; s < m; s++) tmpEle.push(e0 + (e1 - e0) * (m === 1 ? 0 : s / (m - 1)));
      } else {
        tmpEle.push(elev[u]);
        for (let s = 1; s < m - 1; s++) tmpEle.push(elevAt(tmpLat[s], tmpLon[s]));
        if (m > 1) tmpEle.push(elev[v]);
      }
      const [up, down] = gainLoss(tmpEle);
      eU.push(u); eV.push(v); eLen.push(Math.max(len, 0.5));
      eUp.push(up); eDown.push(down); eHw.push(hw); eSurf.push(surf);
      eS0.push(sLat.n); eSn.push(m);
      for (let s = 0; s < m; s++) { sLat.push(tmpLat[s]); sLon.push(tmpLon[s]); sEle.push(tmpEle[s]); }
      start = i;
    }
  }

  const M = eU.n;
  const g = {
    N, M, lat, lon, x, y, elev, center,
    eu: eU.done(), ev: eV.done(), len: eLen.done(), up: eUp.done(), down: eDown.done(),
    hw: eHw.done(), surf: eSurf.done(), s0: eS0.done(), sn: eSn.done(),
    sLat: sLat.done(), sLon: sLon.done(), sEle: sEle.done(),
  };

  // Liste d'adjacence (CSR), graphe non orienté (un piéton peut emprunter les sens uniques).
  const deg = new Int32Array(N + 1);
  for (let e = 0; e < M; e++) { deg[g.eu[e] + 1]++; deg[g.ev[e] + 1]++; }
  for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
  const adjStart = deg.slice();
  const fill = deg.slice(0, N);
  const adjEdge = new Int32Array(2 * M), adjTo = new Int32Array(2 * M), adjRev = new Uint8Array(2 * M);
  for (let e = 0; e < M; e++) {
    let p = fill[g.eu[e]]++; adjEdge[p] = e; adjTo[p] = g.ev[e]; adjRev[p] = 0;
    p = fill[g.ev[e]]++; adjEdge[p] = e; adjTo[p] = g.eu[e]; adjRev[p] = 1;
  }
  Object.assign(g, { adjStart, adjEdge, adjTo, adjRev });
  g.grid = buildGrid(g, 250);
  return g;
}

// --- Index spatial --------------------------------------------------------

function buildGrid(g, cell) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < g.N; i++) {
    if (g.x[i] < minX) minX = g.x[i]; if (g.x[i] > maxX) maxX = g.x[i];
    if (g.y[i] < minY) minY = g.y[i]; if (g.y[i] > maxY) maxY = g.y[i];
  }
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const count = new Int32Array(cols * rows + 1);
  const cellOf = (i) => Math.floor((g.y[i] - minY) / cell) * cols + Math.floor((g.x[i] - minX) / cell);
  for (let i = 0; i < g.N; i++) count[cellOf(i) + 1]++;
  for (let c = 0; c < cols * rows; c++) count[c + 1] += count[c];
  const fill = count.slice(0, cols * rows);
  const items = new Int32Array(g.N);
  for (let i = 0; i < g.N; i++) items[fill[cellOf(i)]++] = i;
  return { cell, cols, rows, minX, minY, start: count, items };
}

/** Itère sur les nœuds dans un rayon r autour de (px, py). */
export function forEachNear(g, px, py, r, fn) {
  const { cell, cols, rows, minX, minY, start, items } = g.grid;
  const c0 = Math.max(0, Math.floor((px - r - minX) / cell)), c1 = Math.min(cols - 1, Math.floor((px + r - minX) / cell));
  const r0 = Math.max(0, Math.floor((py - r - minY) / cell)), r1 = Math.min(rows - 1, Math.floor((py + r - minY) / cell));
  const r2 = r * r;
  for (let rr = r0; rr <= r1; rr++) {
    for (let cc = c0; cc <= c1; cc++) {
      const c = rr * cols + cc;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const i = items[k];
        const dx = g.x[i] - px, dy = g.y[i] - py;
        if (dx * dx + dy * dy <= r2) fn(i, dx * dx + dy * dy);
      }
    }
  }
}

export function nearestNode(g, px, py, ok = () => true) {
  let best = -1, bestD = Infinity;
  for (let r = 200; best < 0 && r < 50000; r *= 2) {
    forEachNear(g, px, py, r, (i, d2) => { if (d2 < bestD && ok(i)) { bestD = d2; best = i; } });
  }
  return best;
}
