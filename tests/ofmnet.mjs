// Réseau construit depuis les tuiles OpenFreeMap (vraies données) : connexité et parcours.
globalThis.self = {};
import { PNG } from 'pngjs';
const { build } = await import('../js/ofmnet.js');
const { loadDem, makeSampler, terrariumToElevation } = await import('../js/elevation.js');
const { bboxAround } = await import('../js/geo.js');
const { buildGraph } = await import('../js/graph.js');
const { solve } = await import('../js/router.js');
const decode = async (url) => terrariumToElevation(PNG.sync.read(Buffer.from(await (await fetch(url)).arrayBuffer())).data);
const [lat0, lon0] = process.argv[2] ? process.argv[2].split(',').map(Number) : [48.8830, 2.3150];
const R = +(process.argv[3] || 4400);
const bbox = bboxAround(lat0, lon0, R);
let t = Date.now();
const res = await build(bbox, () => {});
console.log(`${res.tiles} tuiles, ${res.ways} voies, ${(res.text.length / 1e6).toFixed(1)} Mo en ${Date.now() - t} ms`);
const at = makeSampler(await loadDem(bbox, decode));
t = Date.now();
const g = buildGraph(JSON.parse(res.text).elements, at, [lat0, lon0]);
console.log(`graphe : ${g.N} nœuds, ${g.M} arêtes, composante principale ${g.mainSize} (${Math.round(100 * g.mainSize / g.N)} %) en ${Date.now() - t} ms`);
for (const [mode, extra] of [['loop', {}], ['repeat', {}]]) {
  const r = solve(g, { startLatLon: [lat0, lon0], mode, dmin: 11400, dmax: 12600, surface: 'mixed', budgetMs: 3000, seed: 3, ...extra });
  console.log(mode, r.routes.map((x) => `${(x.distance / 1000).toFixed(1)} km D+${Math.round(x.up)} montées ${x.bigClimbs}`).join(' | '));
}
