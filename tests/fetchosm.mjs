import { overpassQuery, OVERPASS_ENDPOINTS } from '../js/osm.js';
import { bboxAround } from '../js/geo.js';
import fs from 'fs';
const [lat, lon, r, out] = [+process.argv[2], +process.argv[3], +process.argv[4], process.argv[5]];
const q = overpassQuery(bboxAround(lat, lon, r));
for (const u of OVERPASS_ENDPOINTS.slice(0, 2)) {
  try {
    const res = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'parcours-proto/0.1' } });
    const t = await res.text(); console.log(u, res.status, t.length);
    if (res.ok) { fs.writeFileSync(out, t); break; }
  } catch (e) { console.log(u, e.cause?.code || e.message); }
}
