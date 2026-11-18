// Moteur d'optimisation : boucles à fort D+ et répétitions de côte.
// Heuristiques rapides (quelques secondes) plutôt qu'un optimum exact.

import { HW, SURF, gainLoss, forEachNear, nearestNode } from './graph.js';
import { rng } from './geo.js';

// --- Préférences de surface ------------------------------------------------

/** Multiplicateur de coût d'une arête selon la préférence de surface. */
function surfaceMultipliers(g, pref) {
  const m = new Float32Array(g.M);
  const climbOk = new Uint8Array(g.M);
  for (let e = 0; e < g.M; e++) {
    const hw = g.hw[e], paved = g.surf[e] === SURF.PAVED;
    let k = 1;
    if (hw === HW.MAJOR) k = 1.8;
    else if (hw === HW.SECONDARY) k = 1.35;
    else if (hw === HW.TERTIARY) k = 1.1;
    else if (hw === HW.STEPS) k = 1.6;
    let ok = hw !== HW.STEPS && hw !== HW.MAJOR;
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
  constructor(g, surfacePref) {
    this.g = g;
    const { m, climbOk } = surfaceMultipliers(g, surfacePref);
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
        const hil = Math.min((g.up[e] + g.down[e]) / g.len[e], 0.3);
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
    this.dijkstraCount = 0;
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
  leg(a, b, betaIdx, reuseMul = 4) {
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
        const d = du + (used[e] ? C[e] * reuseMul : C[e]);
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
    let L = 0, up = 0, reused = 0, unpaved = 0;
    const seen = new Map();
    for (const [e, rev] of path) {
      L += g.len[e];
      up += rev ? g.down[e] : g.up[e];
      if (g.surf[e] === SURF.UNPAVED) unpaved += g.len[e];
      const k = seen.get(e) || 0;
      if (k > 0) reused += g.len[e];
      seen.set(e, k + 1);
    }
    return { L, up, reused, overlap: L > 0 ? reused / L : 0, unpaved };
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
  const [up, down] = gainLoss(ele);
  let min = Infinity, max = -Infinity;
  for (const x of ele) { if (x < min) min = x; if (x > max) max = x; }
  return {
    lat: Float64Array.from(lat), lon: Float64Array.from(lon),
    ele: Float32Array.from(ele), dist: Float32Array.from(dist),
    distance: d, up, down, minEle: min, maxEle: max,
  };
}

function fastDist(la1, lo1, la2, lo2) {
  const k = Math.cos(((la1 + la2) / 2) * Math.PI / 180);
  const dx = (lo2 - lo1) * k * 111319.49, dy = (la2 - la1) * 111319.49;
  return Math.sqrt(dx * dx + dy * dy);
}

// --- Solveur principal -----------------------------------------------------------

export function solve(g, params, onProgress = () => {}) {
  const t0 = performance.now();
  const {
    startLatLon, mode = 'loop', dmin, dmax, surface = 'mixed', reps = 0,
    climbLen = 'auto', budgetMs = 3000, seed = 1,
  } = params;
  const rand = rng(seed);
  const router = new Router(g, surface);
  const [sx, sy] = project(g, startLatLon);
  const s = nearestNode(g, sx, sy);
  if (s < 0) throw new Error('Aucune voie praticable près du point de départ.');
  const target = (dmin + dmax) / 2;
  const tree = router.tree(s, dmax * 2.2);
  const reach = (i) => tree.len[i] <= dmax * 0.52;

  onProgress({ phase: 'climbs', t: performance.now() - t0 });
  const lenRange = {
    auto: [100, 3200], short: [100, 450], medium: [350, 1100], long: [900, 3200],
  }[climbLen] || [100, 3200];
  const { climbs, path: climbPath } = findClimbs(router, reach, {
    minGain: mode === 'repeat' ? 10 : 8, minLen: lenRange[0], maxLen: lenRange[1],
  });

  const common = { startNode: s, snapDistance: Math.hypot(g.x[s] - sx, g.y[s] - sy) };
  let routes;
  if (mode === 'repeat') {
    routes = solveRepeats(g, router, tree, climbs, climbPath, { dmin, dmax, target, reps, s });
  } else {
    routes = solveLoop(g, router, tree, climbs, climbPath, { dmin, dmax, target, s, budgetMs, rand, t0, onProgress });
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

// --- Répétitions de côte -----------------------------------------------------------

function solveRepeats(g, router, tree, climbs, climbPath, { dmin, dmax, target, reps, s }) {
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
    else {
      N = Math.floor((dmax - 2 * a) / (2 * c.len));
      if (N < 1) N = 1;
      if (N > 60) N = 60;
    }
    const L = 2 * a + 2 * N * c.len;
    const est = N * c.gain + approachUp;
    const score = est - distPenalty(L, dmin, dmax, est / (L / 1000));
    scored.push({ c, E, N, a, L, est, score });
  }
  scored.sort((x, y) => y.score - x.score);
  const pick = pickDistinct(scored, (x) => climbPath(x.c), g.M, 3, 0.3);
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
  const { dmin, dmax, target, s, budgetMs, rand, t0, onProgress } = ctx;
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

  const r0 = target / (2 * Math.PI);

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
    router.used.fill(0);
    const path = [];
    let cur = s;
    const add = (seg) => { for (const t of seg) { path.push(t); router.used[t[0]] = 1; } };
    for (const el of sol.els) {
      const tgt = el.t === 'w' ? el.n : el.c.A;
      const leg = router.leg(cur, tgt, sol.beta);
      if (!leg) return null;
      add(leg);
      if (el.t === 'c') { add(climbPath(el.c)); cur = el.c.B; } else cur = tgt;
    }
    const back = router.leg(cur, s, sol.beta);
    if (!back) return null;
    add(back);
    const st = router.stats(path);
    const upPerKm = st.up / Math.max(st.L / 1000, 0.1);
    const score = st.up * (1 - 0.8 * st.overlap) - distPenalty(st.L, dmin, dmax, upPerKm);
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
    const tooLong = L > dmax, tooShort = L < dmin;
    const r = rand();
    const wps = sol.els.map((e, i) => [e, i]).filter(([e]) => e.t === 'w');
    if ((tooLong || tooShort) && wps.length && r < 0.6) {
      // Mise à l'échelle des points de passage libres
      const f = Math.min(1.6, Math.max(0.6, Math.pow(target / L, 0.9) * (0.9 + rand() * 0.2)));
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
    pool.push({ sol, res });
    pool.sort((a, b) => b.res.score - a.res.score);
    if (pool.length > POOL) pool.length = POOL;
  };

  let evals = 0, lastReport = 0;
  const initBudget = budgetMs * 0.3;
  while (now() < initBudget || evals < 8) {
    const sol = newSolution();
    let res = evaluate(sol); evals++;
    // Réparation rapide de la distance
    let cur = sol;
    for (let k = 0; k < 3 && res && (res.L < dmin || res.L > dmax); k++) {
      const m = mutate(cur, res);
      const r2 = evaluate(m); evals++;
      if (r2 && r2.score > res.score) { cur = m; res = r2; }
    }
    insert(cur, res);
    if (evals > 400) break;
  }
  while (now() < budgetMs && pool.length) {
    // Tournoi biaisé vers les meilleurs
    const i = Math.floor(Math.pow(rand(), 2) * pool.length);
    const { sol, res } = pool[i];
    const m = mutate(sol, res);
    const r2 = evaluate(m); evals++;
    if (r2 && (pool.length < POOL || r2.score > pool[pool.length - 1].res.score)) insert(m, r2);
    if (now() - lastReport > 250) {
      lastReport = now();
      onProgress({ phase: 'search', t: lastReport, best: pool[0]?.res, evals });
    }
  }

  // Résultats variés : on écarte les tracés trop semblables.
  const out = [];
  for (const { res } of pool) {
    const set = new Set(res.path.map(([e]) => e));
    const similar = out.some((o) => {
      let inter = 0;
      for (const e of set) if (o.set.has(e)) inter++;
      return inter / Math.min(set.size, o.set.size) > 0.6;
    });
    if (similar) continue;
    out.push({ set, res });
    if (out.length >= 3) break;
  }
  return out.map(({ res }) => ({
    path: res.path, kind: 'loop', score: res.score, overlap: res.overlap, evals,
  }));
}
