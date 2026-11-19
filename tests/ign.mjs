// Vérifie le décodage / la validation de la grille IGN avec une réponse WMS simulée.
import { PNG } from 'pngjs';
import { loadDem, makeSampler, terrariumToElevation, loadIgnDem, validateIgn } from '../js/elevation.js';
import { bboxAround } from '../js/geo.js';
const realFetch = globalThis.fetch;
const decode = async (url) => terrariumToElevation(PNG.sync.read(Buffer.from(await (await realFetch(url)).arrayBuffer())).data);
const b = bboxAround(48.883, 2.315, 2000);
const terr = await loadDem(b, decode);
const ref = makeSampler(terr);
for (const little of [true, false]) {
  globalThis.fetch = async (url) => {
    const q = new URL(url).searchParams;
    const W = +q.get('WIDTH'), H = +q.get('HEIGHT');
    const [s, w, n, e] = q.get('BBOX').split(',').map(Number);
    const buf = new ArrayBuffer(W * H * 4), dv = new DataView(buf);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const lat = n - (y + 0.5) / H * (n - s), lon = w + (x + 0.5) / W * (e - w);
      dv.setFloat32((y * W + x) * 4, x < 20 ? -99999 : ref(lat, lon) - 3, little);
    }
    return { ok: true, arrayBuffer: async () => buf };
  };
  const ign = await loadIgnDem(b);
  const dem = validateIgn(ign, terr);
  const at = makeSampler(dem);
  console.log(little ? 'LE' : 'BE', dem ? 'OK' : 'REFUSÉ', ign.W + 'x' + ign.H,
    'écart', (at(48.883, 2.315) - ref(48.883, 2.315)).toFixed(2), 'bord (repli)', (at(48.883, b.w + 0.0001) - ref(48.883, b.w + 0.0001)).toFixed(2));
}
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(10) });
try { await loadIgnDem(b); } catch (e) { console.log('réponse invalide →', e.message); }
