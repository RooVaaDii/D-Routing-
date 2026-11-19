// Demi-tours (allers-retours en impasse) dans les parcours variés, sur le vrai relief de Paris
// avec un réseau quadrillé parsemé d'impasses.
import { PNG } from 'pngjs';
import { loadDem, makeSampler, terrariumToElevation } from '../js/elevation.js';
import { bboxAround } from '../js/geo.js';
import { buildGraph } from '../js/graph.js';
import { solve } from '../js/router.js';
const decode = async (url) => terrariumToElevation(PNG.sync.read(Buffer.from(await (await fetch(url)).arrayBuffer())).data);
const [lat0, lon0] = [48.8830, 2.3150];
const at = makeSampler(await loadDem(bboxAround(lat0, lon0, 4500), decode));
const n = 60, step = 0.0012, els = []; let wid = 1, nid = 1e6;
for (let i = 0; i < n; i++) for (const h of [true, false]) {
  const nodes = [], geometry = [];
  for (let j = 0; j < n; j++) { const [a, b] = h ? [i, j] : [j, i]; nodes.push(a * n + b + 1); geometry.push({ lat: lat0 - 0.036 + a * step, lon: lon0 - 0.054 + b * step * 1.5 }); }
  els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: 'residential', name: `${h ? 'Rue' : 'Avenue'} ${i}` } });
}
// Impasses : une courte rue en cul-de-sac à chaque carrefour sur trois
for (let a = 0; a < n; a += 2) for (let b = 1; b < n; b += 3) {
  const la = lat0 - 0.036 + a * step, lo = lon0 - 0.054 + b * step * 1.5;
  els.push({ type: 'way', id: wid++, nodes: [a * n + b + 1, nid, nid + 1], geometry: [{ lat: la, lon: lo }, { lat: la + step * 0.25, lon: lo + step * 0.3 }, { lat: la + step * 0.5, lon: lo + step * 0.6 }], tags: { highway: 'residential', name: `Impasse ${nid}` } });
  nid += 2;
}
const g = buildGraph(els, at, [lat0, lon0]);
const uturns = (r) => { let u = 0; for (let k = 2; k < r.lat.length; k++) if (r.lat[k] === r.lat[k - 2] && r.lon[k] === r.lon[k - 2]) u++; return u; };
for (let seed = 1; seed <= 3; seed++) {
  const r = solve(g, { startLatLon: [lat0, lon0], mode: 'loop', dmin: 11400, dmax: 12600, surface: 'mixed', budgetMs: 2500, seed });
  console.log(`graine ${seed} →`, r.routes.map((x) => `${(x.distance / 1000).toFixed(1)} km D+${Math.round(x.up)} demi-tours ${uturns(x)}`).join(' | '));
}
