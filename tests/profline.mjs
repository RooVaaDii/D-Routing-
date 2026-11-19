import { PNG } from 'pngjs';
import { loadDem, makeSampler, terrariumToElevation } from '../js/elevation.js';
import { bboxAround, haversine } from '../js/geo.js';
const decode = async (url) => terrariumToElevation(PNG.sync.read(Buffer.from(await (await fetch(url)).arrayBuffer())).data);
const dem = await loadDem(bboxAround(48.885, 2.315, 3000), decode);
const at = makeSampler(dem);
const [a, b] = [[48.8800, 2.2920], [48.8870, 2.3110]];
const d = haversine(a[0], a[1], b[0], b[1]); const n = Math.round(d / 30);
const e = []; for (let i = 0; i <= n; i++) e.push(at(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n).toFixed(1));
console.log('Bd Pereire tous les 30 m :', e.join(' '));
// Variation fine : écart-type de (e - moyenne glissante 300 m)
