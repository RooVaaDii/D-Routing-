// Objectif « dénivelé » : le parcours doit atteindre la plage de D+ visée, le plus court possible.
// Relief synthétique (collines) ; le mode distance n'est pas concerné.
import { buildGraph } from '../js/graph.js';
import { solve } from '../js/router.js';
const lat0 = 45.75, lon0 = 4.85, n = 70, step = 0.0012;
const elevAt = (la, lo) => 200 + 60 * Math.sin((la - lat0) * 900) * Math.cos((lo - lon0) * 700) + 30 * Math.sin((lo - lon0) * 2000);
const els = []; let wid = 1;
for (let i = 0; i < n; i++) for (const h of [true, false]) {
  const nodes = [], geometry = [];
  for (let j = 0; j < n; j++) { const [a, b] = h ? [i, j] : [j, i]; nodes.push(a * n + b + 1); geometry.push({ lat: lat0 - 0.042 + a * step, lon: lon0 - 0.042 + b * step * 1.4 }); }
  els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: i % 5 ? 'residential' : 'track', name: `${h ? 'Rue' : 'Avenue'} ${i}` } });
}
const g = buildGraph(els, elevAt, [lat0, lon0]);
let ok = 0, total = 0;
for (const [mode, reps] of [['loop', 0], ['repeat', 0], ['repeat', 3]]) {
  for (const up of [150, 400, 900]) {
    const r = solve(g, { startLatLon: [lat0, lon0], mode, reps, dmin: 1000, dmax: 30000, upTarget: up, upTol: 0.1, surface: 'mixed', budgetMs: 1500, seed: 3 });
    const line = r.routes.map((x) => {
      const inRange = x.up >= up * 0.9 && x.up <= up * 1.1;
      total++; if (inRange) ok++;
      return `${(x.distance / 1000).toFixed(2)} km D+${Math.round(x.up)}${inRange ? '' : ' (hors plage)'}`;
    }).join(' | ');
    console.log(`${mode}${reps ? '×' + reps : ''} objectif +${up} m →`, line);
  }
}
console.log(`dans la plage : ${ok}/${total}`);
