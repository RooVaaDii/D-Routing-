// Test du moteur sur un quadrillage de rues + relief synthétique (collines).
import { buildGraph } from '../js/graph.js';
import { solve } from '../js/router.js';
const lat0 = 45.75, lon0 = 4.85, n = 70, step = 0.0012; // ~95 m x 135 m
const elevAt = (la, lo) => 200 + 60 * Math.sin((la - lat0) * 900) * Math.cos((lo - lon0) * 700) + 30 * Math.sin((lo - lon0) * 2000);
const id = (i, j) => i * n + j + 1;
const els = [];
let wid = 1;
for (let i = 0; i < n; i++) {
  for (const horiz of [true, false]) {
    const nodes = [], geometry = [];
    for (let j = 0; j < n; j++) {
      const [a, b] = horiz ? [i, j] : [j, i];
      nodes.push(id(a, b));
      geometry.push({ lat: lat0 - 0.042 + a * step, lon: lon0 - 0.042 + b * step * 1.4 });
    }
    els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: i % 5 ? 'residential' : 'track' } });
  }
}
let t = performance.now();
const g = buildGraph(els, elevAt, [lat0, lon0]);
console.log('graph', g.N, g.M, Math.round(performance.now() - t), 'ms');
for (const [mode, reps] of [['loop', 0], ['repeat', 0], ['repeat', 5]]) {
  for (const surface of ['mixed', 'trail']) {
    const r = solve(g, { startLatLon: [lat0, lon0], mode, dmin: 9500, dmax: 10500, reps, surface, budgetMs: 2000, seed: 42 });
    console.log(mode, reps, surface, Math.round(r.timeMs) + 'ms', JSON.stringify(r.graph),
      r.routes.map((x) => `${(x.distance / 1000).toFixed(2)}km D+${Math.round(x.up)} D-${Math.round(x.down)} ov${Math.round((x.overlap || 0) * 100)}%` + (x.climb ? ` [${x.climb.reps}x${Math.round(x.climb.length)}m +${Math.round(x.climb.gain)}]` : '')).join(' | '));
  }
}
