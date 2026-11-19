// Objectif « dénivelé » sur le vrai relief de Paris (réseau quadrillé simulé, rues nommées).
import { PNG } from 'pngjs';
import { loadDem, makeSampler, terrariumToElevation } from '../js/elevation.js';
import { bboxAround } from '../js/geo.js';
import { buildGraph } from '../js/graph.js';
import { solve } from '../js/router.js';
const decode = async (url) => terrariumToElevation(PNG.sync.read(Buffer.from(await (await fetch(url)).arrayBuffer())).data);
const [lat0, lon0] = [48.8830, 2.3150];
const at = makeSampler(await loadDem(bboxAround(lat0, lon0, 6000), decode));
const n = 100, step = 0.0009, els = []; let wid = 1;
for (let i = 0; i < n; i++) for (const h of [true, false]) {
  const nodes = [], geometry = [];
  for (let j = 0; j < n; j++) { const [a, b] = h ? [i, j] : [j, i]; nodes.push(a * n + b + 1); geometry.push({ lat: lat0 - 0.045 + a * step, lon: lon0 - 0.068 + b * step * 1.5 }); }
  els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: 'residential', name: `${h ? 'Rue' : 'Avenue'} ${i}` } });
}
const g = buildGraph(els, at, [lat0, lon0]);
for (const [mode, reps] of [['loop', 0], ['repeat', 0], ['repeat', 2]]) for (const up of [100, 250, 400]) {
  const r = solve(g, { startLatLon: [lat0, lon0], mode, reps, dmin: 1000, dmax: Math.min(24, Math.max(4, up / 25)) * 1000, upTarget: up, upTol: 0.1,
    surface: 'mixed', budgetMs: 2500, seed: 7, avoidReuse: true, avoidSameStreet: true, hillCap: 2 });
  console.log(`${mode}${reps ? '×' + reps : ''} +${up} m →`, r.routes.map((x) => `${(x.distance / 1000).toFixed(2)} km D+${Math.round(x.up)}${x.up < up * 0.9 || x.up > up * 1.1 ? ' (hors plage)' : ''}`).join(' | '));
}
