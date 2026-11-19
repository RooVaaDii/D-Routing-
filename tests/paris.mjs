// Quadrillage de rues simulé posé sur le VRAI relief de Paris (17e) : vérifie que
// l'optimiseur n'exploite plus le bruit du MNT.
import { PNG } from 'pngjs';
import { loadDem, makeSampler, terrariumToElevation } from '../js/elevation.js';
import { bboxAround } from '../js/geo.js';
import { buildGraph } from '../js/graph.js';
import { solve } from '../js/router.js';
const decode = async (url) => terrariumToElevation(PNG.sync.read(Buffer.from(await (await fetch(url)).arrayBuffer())).data);
const [lat0, lon0] = [48.8830, 2.3150]; // rue de Saussure
const dem = await loadDem(bboxAround(lat0, lon0, 4500), decode);
const at = makeSampler(dem);
const n = 80, step = 0.0009, els = []; let wid = 1;
for (let i = 0; i < n; i++) for (const h of [true, false]) {
  const nodes = [], geometry = [];
  for (let j = 0; j < n; j++) { const [a, b] = h ? [i, j] : [j, i]; nodes.push(a * n + b + 1); geometry.push({ lat: lat0 - 0.036 + a * step, lon: lon0 - 0.054 + b * step * 1.5 }); }
  els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: 'residential' } });
}
const g = buildGraph(els, at, [lat0, lon0]);
for (const mode of ['loop', 'repeat']) {
  const r = solve(g, { startLatLon: [lat0, lon0], mode, dmin: 11400, dmax: 12600, surface: 'mixed', budgetMs: 3000, seed: 7 });
  for (const x of r.routes) console.log(mode, `${(x.distance / 1000).toFixed(2)} km  D+ ${Math.round(x.up)} m  montées≥10m: ${x.bigClimbs}  alt ${Math.round(x.minEle)}–${Math.round(x.maxEle)}`, x.climb ? `côte ${x.climb.reps}×${Math.round(x.climb.length)}m +${Math.round(x.climb.gain)}` : '');
}
