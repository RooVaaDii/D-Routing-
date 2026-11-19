// Limite du nombre de montées (parcours varié) sur le vrai relief de Paris.
import { PNG } from 'pngjs';
import { loadDem, makeSampler, terrariumToElevation } from '../js/elevation.js';
import { bboxAround } from '../js/geo.js';
import { buildGraph } from '../js/graph.js';
import { solve } from '../js/router.js';
const decode = async (url) => terrariumToElevation(PNG.sync.read(Buffer.from(await (await fetch(url)).arrayBuffer())).data);
const [lat0, lon0] = [48.8830, 2.3150];
const at = makeSampler(await loadDem(bboxAround(lat0, lon0, 4500), decode));
const n = 80, step = 0.0009, els = []; let wid = 1;
for (let i = 0; i < n; i++) for (const h of [true, false]) {
  const nodes = [], geometry = [];
  for (let j = 0; j < n; j++) { const [a, b] = h ? [i, j] : [j, i]; nodes.push(a * n + b + 1); geometry.push({ lat: lat0 - 0.036 + a * step, lon: lon0 - 0.054 + b * step * 1.5 }); }
  els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: 'residential', name: `${h ? 'Rue' : 'Avenue'} ${i}` } });
}
const g = buildGraph(els, at, [lat0, lon0]);
for (const maxClimbs of [0, 5, 3, 2, 1]) {
  const r = solve(g, { startLatLon: [lat0, lon0], mode: 'loop', dmin: 11400, dmax: 12600, surface: 'mixed', budgetMs: 2500, seed: 7, maxClimbs });
  console.log(`montées au plus ${maxClimbs || '∞'} →`, r.routes.map((x) => `${(x.distance / 1000).toFixed(1)} km D+${Math.round(x.up)} montées ${x.bigClimbs}`).join(' | '));
}
