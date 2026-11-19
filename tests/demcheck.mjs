// Bruit du MNT Terrarium à Paris : D+ mesuré le long de lignes droites.
import { PNG } from 'pngjs';
import { loadDem, makeSampler, terrariumToElevation } from '../js/elevation.js';
import { bboxAround, haversine } from '../js/geo.js';
import { gainLoss, climbProfile } from '../js/graph.js';
const decode = async (url) => {
  const r = await fetch(url); const buf = Buffer.from(await r.arrayBuffer());
  return terrariumToElevation(PNG.sync.read(buf).data);
};
const dem = await loadDem(bboxAround(48.885, 2.315, 5000), decode);
console.log('zoom', dem.z, 'tiles', dem.nx * dem.ny);
const at = makeSampler(dem);
const lines = {
  'Bd Malesherbes (Madeleine→Pte d’Asnières)': [[48.8700, 2.3240], [48.8890, 2.3030]],
  'Av. de Clichy (plat)': [[48.8840, 2.3270], [48.8950, 2.3190]],
  'Montée Montmartre (Abbesses→Sacré-Cœur)': [[48.8845, 2.3385], [48.8867, 2.3431]],
  'Bd Pereire (le long des voies)': [[48.8800, 2.2920], [48.8870, 2.3110]],
};
for (const [name, [a, b]] of Object.entries(lines)) {
  const d = haversine(a[0], a[1], b[0], b[1]); const n = Math.round(d / 15);
  const e = []; for (let i = 0; i <= n; i++) e.push(at(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n));
  let raw = 0; for (let i = 1; i < e.length; i++) raw += Math.max(0, e[i] - e[i - 1]);
  console.log(name, `${Math.round(d)} m`, `net ${(e.at(-1) - e[0]).toFixed(1)} m`, `D+ brut ${raw.toFixed(1)}`, `D+ lissé3 ${gainLoss(e)[0].toFixed(1)}`, `D+ hyst4 ${climbProfile(e).up.toFixed(1)}`, 'min/max', Math.min(...e).toFixed(0), Math.max(...e).toFixed(0));
}
