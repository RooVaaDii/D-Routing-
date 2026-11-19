// Vérifie les nouvelles options sur le vrai relief de Paris (réseau quadrillé simulé, rues nommées).
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
const base = { startLatLon: [lat0, lon0], dmin: 11400, dmax: 12600, surface: 'mixed', budgetMs: 3000, seed: 7 };
const show = (label, r) => r.routes.forEach((x, i) => console.log(label, i, `${(x.distance / 1000).toFixed(2)} km D+ ${Math.round(x.up)} montées ${x.bigClimbs} rue-répétée ${Math.round((x.revisit || 0) * 100)}% recouvrement ${Math.round((x.overlap || 0) * 100)}%`,
  x.circuit ? 'circuit ' + x.circuit.map((c) => `${c.reps}×${Math.round(c.length)}m+${Math.round(c.gain)}`).join(' / ') : ''));
show('libre    ', solve(g, { ...base, mode: 'loop', avoidReuse: false, avoidSameStreet: false, hillCap: 0 }));
show('options  ', solve(g, { ...base, mode: 'loop', avoidReuse: true, avoidSameStreet: true, hillCap: 2 }));
show('max1côte ', solve(g, { ...base, mode: 'loop', avoidReuse: true, avoidSameStreet: true, hillCap: 1 }));
show('circuit×2', solve(g, { ...base, mode: 'repeat', reps: 2 }));
