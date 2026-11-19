// Moteur d'optimisation : boucles à fort D+ et répétitions de côte.
// Heuristiques rapides (quelques secondes) plutôt qu'un optimum exact.

import { HW, SURF, climbProfile, climbQuality, forEachNear, nearestNode } from './graph.js';
import { rng } from './geo.js';

// --- Préférences de surface ------------------------------------------------

/** Multiplicateur de coût d'une arête selon la préférence de surface. */
function surfaceMultipliers(g, pref, avoidStairs) {
  const m = new Float32Array(g.M);
  const climbOk = new Uint8Array(g.M);
  for (let e = 0; e < g.M; e++) {
    const hw = g.hw[e], paved = g.surf[e] === SURF.PAVED;
    let k = 1;
    if (hw === HW.MAJOR) k = 1.8;
    else if (hw === HW.SECONDARY) k = 1.35;
    else if (hw === HW.TERTIARY) k = 1.1;
    else if (hw === HW.STEPS) k = avoidStairs ? 8 : 1.5;
    let ok = hw !== HW.MAJOR && !(hw === HW.STEPS && avoidStairs);
    if (pref === 'road') {
      if (!paved) { k *= 3.5; ok = false; }
    } else if (pref === 'trail') {
      if (paved) {
        k *= hw === HW.PATH || hw === HW.PEDESTRIAN || hw === HW.TRACK ? 1.6 : 2.6;
        ok = false;
      } else if (hw === HW.TRACK || hw === HW.PATH) k *= 0.9;
    }
    m[e] = k;
    climbOk[e] = ok ? 1 : 0;
  }
  return { m, climbOk };
}

// --- Tas binaire min ---------------------------------------------------------

class Heap {
  constructor(n = 1024) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.n = 0; }
  clear() { this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() { // renvoie la valeur ; la clé est dans this.top
    const K = this.k, V = this.v;
    const val = V[0]; this.top = K[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = v;
    }
    return val;
  }
}

// --- Routeur ------------------------------------------------------------------

const BETAS = [0, 5, 10, 16]; // intensité de l'attraction vers les pentes

export class Router {
  constructor(g, surfacePref, { avoidStairs = false, avoidReuse = true, avoidSameStreet = true, hillCap = 0 } = {}) {
    this.g = g;
    const { m, climbOk } = surfaceMultipliers(g, surfacePref, avoidStairs);
    this.mult = m;
    this.climbOk = climbOk;
    this.base = new Float32Array(g.M);
    for (let e = 0; e < g.M; e++) this.base[e] = g.len[e] * m[e];
    // Coûts « attirés par la pente » : une boucle a autant de D- que de D+,
    // on favorise donc les arêtes raides dans les deux sens.
    this.hillCost = BETAS.map((beta) => {
      const c = new Float32Array(g.M);
      let minF = Infinity;
      for (let e = 0; e < g.M; e++) {
        // Pente « fiable » : sur une arête courte le bruit du MNT domine, on
        // n'utilise alors que la différence d'altitude entre ses extrémités.
        const l = g.len[e];
        const dz = Math.abs(g.elev[g.ev[e]] - g.elev[g.eu[e]]);
        let hil = l >= 80 ? (g.up[e] + g.down[e]) / l : dz / Math.max(l, 40);
        // Escaliers : une grande volée (Montmartre) est intéressante, un petit
        // escalier de quelques mètres ne doit pas attirer le parcours.
        if (g.hw[e] === HW.STEPS) hil = !avoidStairs && dz >= 6 ? dz / Math.max(l, 20) : 0;
        hil = Math.min(hil, 0.25);
        c[e] = this.base[e] / (1 + beta * hil);
        const f = c[e] / g.len[e];
        if (f < minF) minF = f;
      }
      return { c, minF };
    });
    const N = g.N;
    this.dist = new Float64Array(N);
    this.stamp = new Int32Array(N);
    this.closed = new Int32Array(N);
    this.prevP = new Int32Array(N); // index dans la liste d'adjacence
    this.cur = 1;
    this.heap = new Heap(1 << 14);
    this.used = new Uint8Array(g.M);
    this.streetUsed = new Uint8Array(g.nStreets + 1);
    // Pondérations (pas d'interdiction) contre les passages répétés
    this.reuseMul = avoidReuse ? 5 : 1.6;         // même tronçon
    this.streetMul = avoidSameStreet ? 2.2 : 1;   // même rue (nom OSM)
    this.hillCap = hillCap;                       // montées max sur une même côte (0 = illimité)
    this.dijkstraCount = 0;
  }

  resetUsage() { this.used.fill(0); this.streetUsed.fill(0); }
  markUsed(seg) {
    for (const [e] of seg) { this.used[e] = 1; const st = this.g.street[e]; if (st >= 0) this.streetUsed[st] = 1; }
  }

  /** Arbre des plus courts chemins (coût surface) depuis src, borné en coût. */
  tree(src, maxCost) {
    const g = this.g, N = g.N;
    const cost = new Float64Array(N).fill(Infinity);
    const len = new Float64Array(N).fill(Infinity);
    const up = new Float32Array(N), down = new Float32Array(N);
    const prevP = new Int32Array(N).fill(-1);
    const heap = new Heap(1 << 14);
    cost[src] = 0; len[src] = 0;
    heap.push(0, src);
    while (heap.n) {
      const u = heap.pop();
      const cu = heap.top;
      if (cu > cost[u]) continue;
      if (cu > maxCost) break;
      for (let p = g.adjStart[u]; p < g.adjStart[u + 1]; p++) {
        const e = g.adjEdge[p], v = g.adjTo[p];
        const c = cu + this.base[e];
        if (c < cost[v]) {
          cost[v] = c; len[v] = len[u] + g.len[e];
          const rev = g.adjRev[p];
          up[v] = up[u] + (rev ? g.down[e] : g.up[e]);
          down[v] = down[u] + (rev ? g.up[e] : g.down[e]);
          prevP[v] = p;
          heap.push(c, v);
        }
      }
    }
    return { src, cost, len, up, down, prevP };
  }

  /** Chemin depuis la racine de l'arbre jusqu'à v : liste [arête, sens] (sens 1 = v→u). */
  treePath(t, v) {
    const g = this.g, out = [];
    while (v !== t.src) {
      const p = t.prevP[v];
      if (p < 0) return null;
      // p est l'entrée d'adjacence de u vers v
      out.push([g.adjEdge[p], g.adjRev[p]]);
      v = g.adjRev[p] ? g.ev[g.adjEdge[p]] : g.eu[g.adjEdge[p]];
    }
    return out.reverse();
  }

  /** A* entre a et b avec coût « pente » et pénalité de réutilisation. */
  leg(a, b, betaIdx) {
    const { reuseMul, streetMul, streetUsed } = this;
    const street = this.g.street;
    if (a === b) return [];
    const g = this.g;
    const { c: C, minF } = this.hillCost[betaIdx];
    const tag = ++this.cur;
    const { dist, stamp, closed, prevP, heap, used } = this;
    const bx = g.x[b], by = g.y[b];
    const hf = minF * 0.999;
    heap.clear();
    dist[a] = 0; stamp[a] = tag; prevP[a] = -1;
    heap.push(Math.hypot(g.x[a] - bx, g.y[a] - by) * hf, a);
    this.dijkstraCount++;
    let found = false;
    while (heap.n) {
      const u = heap.pop();
      if (closed[u] === tag) continue;
      closed[u] = tag;
      if (u === b) { found = true; break; }
      const du = dist[u];
      for (let p = g.adjStart[u]; p < g.adjStart[u + 1]; p++) {
        const v = g.adjTo[p];
        if (closed[v] === tag) continue;
        const e = g.adjEdge[p];
        const st = street[e];
        const d = du + C[e] * (used[e] ? reuseMul : st >= 0 && streetUsed[st] ? streetMul : 1);
        if (stamp[v] !== tag || d < dist[v]) {
          stamp[v] = tag; dist[v] = d; prevP[v] = p;
          heap.push(d + Math.hypot(g.x[v] - bx, g.y[v] - by) * hf, v);
        }
      }
    }
    if (!found) return null;
    const out = [];
    let v = b;
    while (v !== a) {
      const p = prevP[v];
      const e = g.adjEdge[p], rev = g.adjRev[p];
      out.push([e, rev]);
      v = rev ? g.ev[e] : g.eu[e];
    }
    return out.reverse();
  }

  /** Statistiques d'un parcours (liste de traversées). */
  stats(path) {
    const g = this.g;
    let L = 0, reused = 0, unpaved = 0;
    const seen = new Map();
    const eles = this.eleBuf || (this.eleBuf = []);
    const idx = this.idxBuf || (this.idxBuf = []);
    eles.length = 0; idx.length = 0;
    // Passages répétés dans une même rue : une « visite » = suite d'arêtes de la même rue
    const visits = new Map();
    let revisit = 0, runStreet = -2;
    for (let k = 0; k < path.length; k++) {
      const [e, rev] = path[k];
      const s0 = g.s0[e], n = g.sn[e];
      for (let j = k ? 1 : 0; j < n; j++) { const i = rev ? s0 + n - 1 - j : s0 + j; eles.push(g.sEle[i]); idx.push(i); }
      L += g.len[e];
      const st = g.street[e];
      if (st !== runStreet) { runStreet = st; if (st >= 0) visits.set(st, (visits.get(st) || 0) + 1); }
      if (st >= 0 && visits.get(st) > 1) revisit += g.len[e];
      if (g.surf[e] === SURF.UNPAVED) unpaved += g.len[e];
      const c = seen.get(e) || 0;
      if (c > 0) reused += g.len[e];
      seen.set(e, c + 1);
    }
    const prof = climbProfile(eles);
    // Même côte gravie trop souvent : les sommets proches (< 300 m) comptent pour une même côte.
    let excess = 0;
    if (this.hillCap > 0) {
      const hills = []; // {x, y, gains[]}
      prof.climbs.forEach((gain, k) => {
        if (gain < 10) return;
        const i = idx[prof.peaks[k]];
        const x = (g.sLon[i] - g.center[1]) * 111320 * Math.cos(g.center[0] * Math.PI / 180), y = (g.sLat[i] - g.center[0]) * 110540;
        let h = hills.find((h) => Math.hypot(h.x - x, h.y - y) < 300);
        if (!h) { h = { x, y, gains: [] }; hills.push(h); }
        h.gains.push(gain);
      });
      for (const h of hills) {
        if (h.gains.length <= this.hillCap) continue;
        h.gains.sort((a, b) => b - a);
        excess += climbQuality(h.gains.slice(this.hillCap));
      }
    }
    return {
      L, up: prof.up, quality: climbQuality(prof.climbs), excess, reused, overlap: L > 0 ? reused / L : 0,
      revisit: L > 0 ? revisit / L : 0, unpaved,
    };
  }
}

// --- Montées (programmation dynamique sur le DAG des arêtes montantes) --------

const BUCKETS = [150, 250, 400, 650, 1000, 1500, 2200, 3200];
const NB = BUCKETS.length;
const bucketOf = (l) => { let b = 0; while (b < NB - 1 && l > BUCKETS[b]) b++; return b; };

/**
 * Pour chaque nœud et chaque tranche de longueur, la montée la plus haute qui
 * y aboutit en n'empruntant que des arêtes montantes. Coût linéaire.
 */
export function findClimbs(router, reach, { minGain = 8, minLen = 100, maxLen = 3200 } = {}) {
  const g = router.g, N = g.N, elev = g.elev;
  const start = new Int32Array(N * NB).fill(-1);
  const lenA = new Float32Array(N * NB);
  const prevN = new Int32Array(N * NB);
  const prevB = new Int8Array(N * NB);
  const edgeA = new Int32Array(N * NB);
  const revA = new Uint8Array(N * NB);
  const order = [];
  for (let i = 0; i < N; i++) if (reach(i)) order.push(i);
  order.sort((a, b) => elev[a] - elev[b]);

  const tryUpd = (v, nl, s, u, pb, e, rev) => {
    const slot = v * NB + bucketOf(nl);
    const cs = start[slot];
    if (cs >= 0) {
      const dg = elev[cs] - elev[s]; // >0 si le nouveau départ est plus bas
      if (dg < 0.05 && !(dg > -0.05 && nl < lenA[slot])) return;
    }
    start[slot] = s; lenA[slot] = nl; prevN[slot] = u; prevB[slot] = pb; edgeA[slot] = e; revA[slot] = rev;
  };

  for (const u of order) {
    const eu = elev[u];
    for (let p = g.adjStart[u]; p < g.adjStart[u + 1]; p++) {
      const e = g.adjEdge[p];
      if (!router.climbOk[e]) continue;
      const v = g.adjTo[p];
      if (elev[v] <= eu + 0.3) continue;
      const rev = g.adjRev[p];
      if ((rev ? g.up[e] : g.down[e]) > 2.5) continue; // pas de vraie descente dans la montée
      const l = g.len[e];
      if (l > maxLen) continue;
      tryUpd(v, l, u, u, -1, e, rev);
      for (let b = 0; b < NB; b++) {
        const slot = u * NB + b;
        if (start[slot] < 0) continue;
        const nl = lenA[slot] + l;
        if (nl > maxLen) continue;
        tryUpd(v, nl, start[slot], u, b, e, rev);
      }
    }
  }

  const climbs = [];
  for (let slot = 0; slot < N * NB; slot++) {
    const s = start[slot];
    if (s < 0) continue;
    const v = (slot / NB) | 0;
    const gain = elev[v] - elev[s];
    const len = lenA[slot];
    if (gain < minGain || len < minLen || gain / len > 0.35) continue; // > 35 % : artefact du MNT
    climbs.push({ slot, A: s, B: v, len, gain, grade: gain / len });
  }
  const path = (c) => {
    if (c.edges) return c.edges;
    const out = [];
    let slot = c.slot;
    for (;;) {
      out.push([edgeA[slot], revA[slot]]);
      if (prevB[slot] < 0) break;
      slot = prevN[slot] * NB + prevB[slot];
    }
    c.edges = out.reverse();
    return c.edges;
  };
  return { climbs, path };
}

/** Sélection gloutonne de montées peu redondantes (arêtes partagées < maxShare). */
function pickDistinct(list, pathOf, M, count, maxShare = 0.35) {
  const taken = new Uint8Array(M);
  const out = [];
  for (const c of list) {
    const p = pathOf(c);
    let shared = 0;
    for (const [e] of p) if (taken[e]) shared++;
    if (shared / p.length > maxShare) continue;
    for (const [e] of p) taken[e] = 1;
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

const reversePath = (p) => p.slice().reverse().map(([e, r]) => [e, r ^ 1]);

// --- Parcours final -------------------------------------------------------------

/** Convertit une liste de traversées en tracé détaillé + profil. */
export function materialize(g, path, startNode) {
  const lat = [], lon = [], ele = [], dist = [];
  let d = 0;
  const pushPt = (la, lo, el) => {
    if (lat.length) d += fastDist(lat[lat.length - 1], lon[lon.length - 1], la, lo);
    lat.push(la); lon.push(lo); ele.push(el); dist.push(d);
  };
  if (!path.length) pushPt(g.lat[startNode], g.lon[startNode], g.elev[startNode]);
  for (let k = 0; k < path.length; k++) {
    const [e, rev] = path[k];
    const s0 = g.s0[e], n = g.sn[e];
    for (let j = 0; j < n; j++) {
      if (j === 0 && k > 0) continue;
      const i = rev ? s0 + n - 1 - j : s0 + j;
      pushPt(g.sLat[i], g.sLon[i], g.sEle[i]);
    }
  }
  const { up, down, climbs } = climbProfile(ele);
  let min = Infinity, max = -Infinity;
  for (const x of ele) { if (x < min) min = x; if (x > max) max = x; }
  return {
    lat: Float64Array.from(lat), lon: Float64Array.from(lon),
    ele: Float32Array.from(ele), dist: Float32Array.from(dist),
    distance: d, up, down, minEle: min, maxEle: max,
    bigClimbs: climbs.filter((c) => c >= 10).length,
  };
}

function fastDist(la1, lo1, la2, lo2) {
  const k = Math.cos(((la1 + la2) / 2) * Math.PI / 180);
  const dx = (lo2 - lo1) * k * 111319.49, dy = (la2 - la1) * 111319.49;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Tracé allégé (lat, lon entrelacés) pour l'animation de la recherche. */
export function pathCoords(g, path, startNode) {
  const out = [];
  let cur = startNode;
  out.push(g.lat[cur], g.lon[cur]);
  for (const [e, rev] of path) {
    const n = g.sn[e];
    if (n >= 5) { const i = g.s0[e] + (n >> 1); out.push(g.sLat[i], g.sLon[i]); }
    cur = rev ? g.eu[e] : g.ev[e];
    out.push(g.lat[cur], g.lon[cur]);
  }
  return Float32Array.from(out);
}

// --- Solveur principal -----------------------------------------------------------

export function solve(g, params, onProgress = () => {}) {
  const t0 = performance.now();
  const {
    startLatLon, mode = 'loop', dmin, dmax, surface = 'mixed', reps = 0,
    climbLen = 'auto', budgetMs = 3000, seed = 1, avoidStairs = false,
    avoidReuse = true, avoidSameStreet = true, hillCap = 2,
    upTarget = 0, upTol = 0.1, // objectif « dénivelé » (0 = objectif distance, comportement d'origine)
  } = params;
  const goalUp = upTarget > 0 ? { target: upTarget, lo: upTarget * (1 - upTol), hi: upTarget * (1 + upTol) } : null;
  const rand = rng(seed);
  const circuit = mode === 'repeat' && reps > 0; // N répétitions de plusieurs côtes
  const router = new Router(g, surface, {
    avoidStairs,
    avoidReuse: circuit ? false : avoidReuse,
    avoidSameStreet: circuit ? false : avoidSameStreet,
    hillCap: circuit ? reps : mode === 'loop' ? hillCap : 0,
  });
  const [sx, sy] = project(g, startLatLon);
  // Départ accroché au réseau principal (pas à un îlot de chemins isolé)
  const minComp = Math.min(g.mainSize, Math.max(200, g.mainSize * 0.2));
  const s = nearestNode(g, sx, sy, (i) => g.compSize[g.comp[i]] >= minComp);
  if (s < 0) throw new Error('Aucune voie praticable près du point de départ.');
  const target = (dmin + dmax) / 2;
  const tree = router.tree(s, dmax * 2.2);
  const reach = (i) => tree.len[i] <= dmax * 0.52;

  onProgress({ phase: 'climbs', t: performance.now() - t0 });
  const lenRange = {
    auto: [100, 3200], short: [100, 450], medium: [350, 1100], long: [900, 3200],
  }[climbLen] || [100, 3200];
  const { climbs, path: climbPath } = findClimbs(router, reach, {
    minGain: mode === 'repeat' ? 15 : 8, minLen: Math.max(lenRange[0], mode === 'repeat' ? 150 : 100), maxLen: lenRange[1],
  });

  const common = { startNode: s, snapDistance: Math.hypot(g.x[s] - sx, g.y[s] - sy) };
  let routes;
  if (mode === 'repeat' && !circuit) {
    routes = solveRepeats(g, router, tree, climbs, climbPath, { dmin, dmax, target, reps, s, onProgress, goalUp });
  } else {
    routes = solveLoop(g, router, tree, climbs, climbPath, {
      dmin, dmax, target, s, budgetMs, rand, t0, onProgress,
      circuitReps: circuit ? reps : 0,
      wOverlap: circuit ? 0 : avoidReuse ? 1 : 0.25,
      wStreet: circuit ? 0 : avoidSameStreet ? 0.7 : 0,
      goalUp,
    });
  }
  return {
    ...common,
    routes: routes.map((r) => ({ ...r, ...materialize(g, r.path, s), path: undefined })),
    timeMs: performance.now() - t0,
    graph: { nodes: g.N, edges: g.M, climbs: climbs.length, dijkstra: router.dijkstraCount },
  };
}

function project(g, [lat, lon]) {
  const RAD = Math.PI / 180, R = 6371008.8;
  const [lat0, lon0] = g.center;
  return [(lon - lon0) * Math.cos(lat0 * RAD) * R * RAD, (lat - lat0) * R * RAD];
}

function distPenalty(L, dmin, dmax, upPerKm) {
  const dev = L < dmin ? dmin - L : L > dmax ? L - dmax : 0;
  return (dev / 1000) * (60 + 3 * upPerKm);
}

// --- Objectif « dénivelé » : atteindre la plage de D+ visée, puis le plus court possible ---
const GOAL_SHORT = 4;   // points perdus par mètre de D+ sous la valeur visée
const GOAL_UNDER = 8;   // … en plus, par mètre sous la marge
const GOAL_OVER = 2;    // … par mètre au-delà de la marge
const GOAL_KM = 15;     // … par kilomètre parcouru (départage : plus court = mieux)

/** Écart (m) entre un D+ et la plage visée ; 0 si dedans. */
const goalGap = (goal, up) => (up < goal.lo ? goal.lo - up : up > goal.hi ? up - goal.hi : 0);

/** Pénalité commune : D+ hors plage et longueur. */
function goalPenalty(goal, up, L) {
  return GOAL_SHORT * Math.max(0, goal.target - up) + GOAL_UNDER * Math.max(0, goal.lo - up)
    + GOAL_OVER * Math.max(0, up - goal.hi) + GOAL_KM * (L / 1000);
}

// --- Répétitions de côte -----------------------------------------------------------

function solveRepeats(g, router, tree, climbs, climbPath, { dmin, dmax, target, reps, s, onProgress, goalUp = null }) {
  const scored = [];
  for (const c of climbs) {
    // On rejoint l'extrémité la plus proche (pied ou sommet).
    const endA = tree.len[c.A], endB = tree.len[c.B];
    const E = endA <= endB ? c.A : c.B;
    const a = Math.min(endA, endB);
    if (!isFinite(a)) continue;
    const approachUp = tree.up[E] + tree.down[E]; // aller + retour
    let N;
    if (reps > 0) N = reps;
    else if (goalUp) {
      // Juste assez de répétitions pour atteindre le D+ visé.
      N = Math.ceil(Math.max(0, goalUp.target - approachUp) / c.gain);
      if (N < 1) N = 1;
      if (N > 60) N = 60;
    } else {
      N = Math.floor((dmax - 2 * a) / (2 * c.len));
      if (N < 1) N = 1;
      if (N > 60) N = 60;
    }
    const L = 2 * a + 2 * N * c.len;
    const est = N * c.gain + approachUp;
    // Le mode « côte » doit tirer son D+ des répétitions, pas du trajet d'accès.
    const approachPen = Math.max(0, 2 * a - 0.35 * L) / 1000 * 40;
    const score = goalUp
      ? goalUp.target - approachPen - goalPenalty(goalUp, est, L) - distPenalty(L, dmin, dmax, est / (L / 1000))
      : N * c.gain + 0.3 * approachUp - approachPen - distPenalty(L, dmin, dmax, est / (L / 1000));
    scored.push({ c, E, N, a, L, est, score });
  }
  scored.sort((x, y) => y.score - x.score);
  // Trois propositions variées : la meilleure côte courte, moyenne et longue
  // (puis les meilleures restantes si une catégorie est vide).
  const classOf = (x) => (x.c.len < 350 ? 0 : x.c.len < 800 ? 1 : 2);
  const firsts = [0, 1, 2].map((k) => scored.find((x) => classOf(x) === k)).filter(Boolean);
  const ordered = [...firsts.sort((a, b) => b.score - a.score), ...scored];
  const pick = pickDistinct(ordered, (x) => climbPath(x.c), g.M, 3, 0.15);
  // Côtes examinées, envoyées à l'interface pour l'animation de recherche.
  const explored = pickDistinct(scored, (x) => climbPath(x.c), g.M, 14, 0.5);
  onProgress({
    phase: 'climbs-explored',
    candidates: explored.map((x) => ({
      coords: pathCoords(g, climbPath(x.c), x.c.A), up: x.c.gain, L: x.c.len,
    })),
  });
  return pick.map((x) => {
    const climb = climbPath(x.c);
    const down = reversePath(climb);
    const approach = router.treePath(tree, x.E) || [];
    const path = [...approach];
    const fromTop = x.E === x.c.B;
    for (let i = 0; i < x.N; i++) {
      if (fromTop) path.push(...down, ...climb);
      else path.push(...climb, ...down);
    }
    path.push(...reversePath(approach));
    return {
      path,
      kind: 'repeat',
      climb: {
        length: x.c.len, gain: x.c.gain, grade: x.c.grade, reps: x.N,
        bottom: [g.lat[x.c.A], g.lon[x.c.A]], top: [g.lat[x.c.B], g.lon[x.c.B]],
        approach: x.a,
        coords: materialize(g, climb, x.c.A),
      },
      score: x.score,
    };
  });
}

// --- Boucle libre --------------------------------------------------------------------

function solveLoop(g, router, tree, climbs, climbPath, ctx) {
  const { dmin, dmax, s, budgetMs, rand, t0, onProgress, circuitReps = 0, wOverlap = 1, wStreet = 0.7, goalUp = null } = ctx;
  let { target } = ctx;
  const sx = g.x[s], sy = g.y[s];
  const now = () => performance.now() - t0;

  // Montées candidates : faisables dans le budget distance, triées par « valeur ».
  const feas = climbs.filter((c) => tree.len[c.A] + c.len + tree.len[c.B] <= dmax * 1.02);
  feas.forEach((c) => { c.value = c.gain * Math.sqrt(c.grade); });
  feas.sort((a, b) => b.value - a.value);
  const cands = pickDistinct(feas, climbPath, g.M, 120, 0.4);
  for (const c of cands) {
    c.ang = Math.atan2((g.y[c.A] + g.y[c.B]) / 2 - sy, (g.x[c.A] + g.x[c.B]) / 2 - sx);
  }

  if (circuitReps && !cands.length) throw new Error('Aucune côte assez marquée à proximité pour un circuit de répétitions.');
  if (goalUp) {
    // Distance de départ estimée d'après la densité des montées du coin (affinée ensuite).
    const dens = cands.slice(0, 20).map((c) => c.gain / c.len).sort((a, b) => a - b);
    const d = dens.length ? Math.min(0.08, Math.max(0.008, 0.45 * dens[dens.length >> 1])) : 0.015;
    target = Math.min(dmax * 0.9, Math.max(dmin, goalUp.target / d));
  }
  const r0 = target / (2 * Math.PI);
  // Hors objectif : la distance (mode d'origine) ou le D+ (objectif dénivelé).
  const outOfRange = goalUp ? (res) => goalGap(goalUp, res.up) > 0 : (res) => res.L < dmin || res.L > dmax;

  // Accroche un point à un nœud accessible, en privilégiant le haut ou le bas.
  const snap = (px, py, role, rad) => {
    let best = -1, bestV = -Infinity;
    forEachNear(g, px, py, rad, (i, d2) => {
      if (!(tree.len[i] <= dmax * 0.5)) return;
      const e = g.elev[i];
      const v = (role === 'high' ? e : role === 'low' ? -e : 0) - Math.sqrt(d2) * 0.004;
      if (v > bestV) { bestV = v; best = i; }
    });
    if (best < 0) best = nearestNode(g, px, py, (i) => tree.len[i] <= dmax * 0.5);
    return best;
  };

  const angleOf = (el) => el.t === 'c' ? el.c.ang : Math.atan2(g.y[el.n] - sy, g.x[el.n] - sx);
  const order = (sol) => {
    const a0 = sol.a0;
    const norm = (a) => { let d = (a - a0) * sol.dir; d %= 2 * Math.PI; return d < 0 ? d + 2 * Math.PI : d; };
    sol.els.sort((p, q) => norm(angleOf(p)) - norm(angleOf(q)));
  };

  const evaluate = (sol) => {
    router.resetUsage();
    const path = [];
    let cur = s;
    const add = (seg) => { for (const t of seg) path.push(t); router.markUsed(seg); };
    for (const el of sol.els) {
      const tgt = el.t === 'w' ? el.n : el.c.A;
      const leg = router.leg(cur, tgt, sol.beta);
      if (!leg) return null;
      add(leg);
      if (el.t === 'c') {
        const up = climbPath(el.c);
        add(up);
        // Circuit de côtes : chaque côte est répétée N fois (descente + remontée)
        for (let r = 1; r < (circuitReps || 1); r++) { add(reversePath(up)); add(up); }
        cur = el.c.B;
      } else cur = tgt;
    }
    const back = router.leg(cur, s, sol.beta);
    if (!back) return null;
    add(back);
    const st = router.stats(path);
    const upPerKm = st.up / Math.max(st.L / 1000, 0.1);
    // On optimise la « qualité » des montées (les mini-bosses ne rapportent rien).
    const q = st.quality - 1.5 * st.excess;
    let score;
    if (goalUp) {
      // Part du D+ venant de vraies montées : les « dents de scie » restent pénalisées.
      const shape = Math.min(1, Math.max(0, q / Math.max(st.up, 1)));
      score = goalUp.target * (0.6 + 0.4 * shape) * (1 - wOverlap * st.overlap) * (1 - wStreet * st.revisit)
        - goalPenalty(goalUp, st.up, st.L) - distPenalty(st.L, dmin, dmax, upPerKm);
    } else score = q * (1 - wOverlap * st.overlap) * (1 - wStreet * st.revisit) - distPenalty(st.L, dmin, dmax, upPerKm);
    return { path, ...st, score };
  };

  const randomWaypoints = (k, scale) => {
    const theta = rand() * 2 * Math.PI;
    const r = r0 * scale;
    const cx = sx + r * Math.cos(theta), cy = sy + r * Math.sin(theta);
    const els = [];
    let role = rand() < 0.5 ? 'high' : 'low';
    for (let i = 1; i <= k; i++) {
      const phi = theta + Math.PI + (2 * Math.PI * i) / (k + 1);
      const n = snap(cx + r * Math.cos(phi), cy + r * Math.sin(phi), role, Math.max(150, 0.4 * r));
      if (n >= 0 && n !== s) els.push({ t: 'w', n, role });
      role = role === 'high' ? 'low' : 'high';
    }
    return els;
  };

  const pickClimb = () => cands[Math.floor(Math.pow(rand(), 2) * cands.length)];

  const newSolution = () => {
    const sol = { els: [], beta: 1 + Math.floor(rand() * 3), dir: rand() < 0.5 ? 1 : -1, a0: rand() * 2 * Math.PI };
    if (circuitReps) {
      const k = 1 + Math.floor(rand() * Math.min(3, cands.length));
      const set = new Set();
      while (set.size < k) set.add(pickClimb());
      for (const c of set) sol.els.push({ t: 'c', c });
      order(sol);
      return sol;
    }
    const kind = rand();
    if (cands.length && kind < 0.65) {
      const k = 1 + Math.floor(rand() * Math.min(3, cands.length));
      const set = new Set();
      while (set.size < k) set.add(pickClimb());
      for (const c of set) sol.els.push({ t: 'c', c });
      if (rand() < 0.5) sol.els.push(...randomWaypoints(1, 0.8 + rand() * 0.6));
    } else {
      sol.els = randomWaypoints(2 + Math.floor(rand() * 2), 0.75 + rand() * 0.7);
      if (cands.length && rand() < 0.4) sol.els.push({ t: 'c', c: pickClimb() });
    }
    if (!sol.els.length) sol.els = randomWaypoints(2, 1);
    order(sol);
    return sol;
  };

  const clone = (sol) => ({ ...sol, els: sol.els.slice() });

  const mutate = (base, res) => {
    const sol = clone(base);
    const L = res.L;
    const tooLong = goalUp ? res.up > goalUp.hi : L > dmax, tooShort = goalUp ? res.up < goalUp.lo : L < dmin;
    const r = rand();
    if (circuitReps) {
      // Circuit de côtes : on ajoute, retire ou remplace des côtes
      if (tooLong && sol.els.length > 1) sol.els.splice(Math.floor(rand() * sol.els.length), 1);
      else if (tooShort || r < 0.2) sol.els.push({ t: 'c', c: pickClimb() });
      else if (r < 0.65) sol.els[Math.floor(rand() * sol.els.length)] = { t: 'c', c: pickClimb() };
      else if (r < 0.8 && sol.els.length > 1) sol.els.splice(Math.floor(rand() * sol.els.length), 1);
      else if (r < 0.9) sol.beta = Math.floor(rand() * BETAS.length);
      else sol.dir = -sol.dir;
      const seen = new Set();
      sol.els = sol.els.filter((e) => !seen.has(e.c.slot) && seen.add(e.c.slot));
      if (!sol.els.length) sol.els.push({ t: 'c', c: pickClimb() });
      order(sol);
      return sol;
    }
    const wps = sol.els.map((e, i) => [e, i]).filter(([e]) => e.t === 'w');
    if ((tooLong || tooShort) && wps.length && r < 0.6) {
      // Mise à l'échelle des points de passage libres
      const ratio = goalUp ? goalUp.target / Math.max(res.up, 1) : target / L;
      const f = Math.min(1.6, Math.max(0.6, Math.pow(ratio, 0.9) * (0.9 + rand() * 0.2)));
      for (const [e, i] of wps) {
        const nx = sx + (g.x[e.n] - sx) * f, ny = sy + (g.y[e.n] - sy) * f;
        const n = snap(nx, ny, e.role, Math.max(120, 0.25 * r0));
        if (n >= 0) sol.els[i] = { ...e, n };
      }
    } else if (tooLong && sol.els.length > 1 && r < 0.85) {
      sol.els.splice(Math.floor(rand() * sol.els.length), 1);
    } else if (tooShort && r < 0.85) {
      if (cands.length && rand() < 0.6) sol.els.push({ t: 'c', c: pickClimb() });
      else sol.els.push(...randomWaypoints(1, 1 + rand() * 0.5));
    } else {
      const op = rand();
      if (op < 0.35 && wps.length) {
        const [e, i] = wps[Math.floor(rand() * wps.length)];
        const ang = rand() * 2 * Math.PI, d = r0 * (0.15 + rand() * 0.35);
        const n = snap(g.x[e.n] + d * Math.cos(ang), g.y[e.n] + d * Math.sin(ang), e.role, Math.max(120, 0.2 * r0));
        if (n >= 0) sol.els[i] = { ...e, n };
      } else if (op < 0.55 && cands.length) {
        // Remplacer / ajouter une montée
        const ci = sol.els.findIndex((e) => e.t === 'c');
        if (ci >= 0 && rand() < 0.6) sol.els[ci] = { t: 'c', c: pickClimb() };
        else sol.els.push({ t: 'c', c: pickClimb() });
      } else if (op < 0.7 && sol.els.length > 1) {
        sol.els.splice(Math.floor(rand() * sol.els.length), 1);
      } else if (op < 0.85) {
        sol.beta = Math.floor(rand() * BETAS.length);
      } else {
        sol.dir = -sol.dir;
      }
    }
    // Pas deux fois la même montée
    const seen = new Set();
    sol.els = sol.els.filter((e) => {
      const k = e.t === 'c' ? 'c' + e.c.slot : 'w' + e.n;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    if (!sol.els.length) sol.els = randomWaypoints(2, 1);
    order(sol);
    return sol;
  };

  const pool = []; // {sol, res}
  const POOL = 14;
  const insert = (sol, res) => {
    if (!res) return;
    // Niches : un tracé trop proche d'un autre déjà retenu le remplace seulement
    // s'il est meilleur. On garde ainsi des propositions variées.
    res.set = new Set(res.path.map(([e]) => e));
    for (let k = 0; k < pool.length; k++) {
      const o = pool[k].res.set;
      let inter = 0;
      for (const e of res.set) if (o.has(e)) inter++;
      if (inter / Math.min(res.set.size, o.size) > 0.6) {
        if (res.score > pool[k].res.score) pool[k] = { sol, res };
        pool.sort((a, b) => b.res.score - a.res.score);
        return;
      }
    }
    pool.push({ sol, res });
    pool.sort((a, b) => b.res.score - a.res.score);
    if (pool.length > POOL) pool.length = POOL;
  };

  let evals = 0, lastReport = 0;
  const initBudget = budgetMs * 0.3;
  let shown = [];
  const consider = (res) => {
    if (res && shown.length < 4 && (shown.length === 0 || Math.random() < 0.35)) shown.push(res);
  };
  const report = (force) => {
    if (!force && now() - lastReport < 110) return;
    lastReport = now();
    const best = pool[0]?.res;
    onProgress({
      phase: 'search', t: lastReport, evals, progress: Math.min(1, lastReport / budgetMs),
      best: best && { up: best.up, L: best.L, coords: pathCoords(g, best.path, s) },
      candidates: shown.map((r) => ({ up: r.up, L: r.L, coords: pathCoords(g, r.path, s) })),
    });
    shown = [];
  };
  while (now() < initBudget || evals < 8) {
    const sol = newSolution();
    let res = evaluate(sol); evals++;
    consider(res);
    // Réparation rapide de la distance
    let cur = sol;
    for (let k = 0; k < 3 && res && outOfRange(res); k++) {
      const m = mutate(cur, res);
      const r2 = evaluate(m); evals++;
      if (r2 && r2.score > res.score) { cur = m; res = r2; }
    }
    insert(cur, res);
    report();
    if (evals > 400) break;
  }
  while (now() < budgetMs && pool.length) {
    // Tournoi biaisé vers les meilleurs
    const i = Math.floor(Math.pow(rand(), 2) * pool.length);
    const { sol, res } = pool[i];
    const m = mutate(sol, res);
    const r2 = evaluate(m); evals++;
    consider(r2);
    if (r2 && (pool.length < POOL || r2.score > pool[pool.length - 1].res.score)) insert(m, r2);
    report();
  }
  report(true);

  // Résultats variés : on écarte les tracés trop semblables.
  const out = [];
  for (const { sol, res } of pool) {
    const set = new Set(res.path.map(([e]) => e));
    const similar = out.some((o) => {
      let inter = 0;
      for (const e of set) if (o.set.has(e)) inter++;
      return inter / Math.min(set.size, o.set.size) > 0.6;
    });
    if (similar) continue;
    out.push({ set, res, sol });
    if (out.length >= 3) break;
  }
  return out.map(({ res, sol }) => ({
    path: res.path, kind: circuitReps ? 'circuit' : 'loop', score: res.score, overlap: res.overlap,
    revisit: res.revisit, evals,
    circuit: circuitReps ? sol.els.map((e) => ({
      length: e.c.len, gain: e.c.gain, grade: e.c.grade, reps: circuitReps,
      top: [g.lat[e.c.B], g.lon[e.c.B]],
    })) : undefined,
  }));
}
