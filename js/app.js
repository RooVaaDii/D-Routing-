// Interface : carte Leaflet, formulaire, appels au worker, affichage des résultats.
import { bboxAround, haversine } from './geo.js';
import { fetchOsm } from './osm.js';
import { loadDem, browserDecode } from './elevation.js';
import { drawProfile, indexAt } from './profile.js';
import { toGpx, downloadText } from './gpx.js';

const $ = (id) => document.getElementById(id);
const L = window.L;

// --- Carte -------------------------------------------------------------------
const map = L.map('map', { zoomControl: false }).setView([45.764, 4.8357], 13);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Altitude : Terrarium (Mapzen/AWS)',
}).addTo(map);

let start = null;
const startMarker = L.marker([0, 0], {
  draggable: true,
  icon: L.divIcon({ className: 'start-pin', iconSize: [18, 18] }),
});
startMarker.on('dragend', () => setStart(startMarker.getLatLng(), false));
const hoverMarker = L.marker([0, 0], { icon: L.divIcon({ className: 'hover-pin', iconSize: [12, 12] }), interactive: false });
const routeLayer = L.layerGroup().addTo(map);

function setStart(ll, pan = true) {
  start = [ll.lat, ll.lng];
  startMarker.setLatLng(ll).addTo(map);
  if (pan) map.setView(ll, Math.max(map.getZoom(), 14));
  status('Départ placé. Choisis la distance puis « Générer ».');
}
map.on('click', (e) => setStart(e.latlng, false));

// --- Formulaire ----------------------------------------------------------------
const status = (msg, err = false) => { $('status').textContent = msg; $('status').classList.toggle('error', err); };
const val = (name) => document.querySelector(`input[name=${name}]:checked`).value;

document.querySelectorAll('input[name=mode]').forEach((r) =>
  r.addEventListener('change', () => { $('repsField').hidden = val('mode') !== 'repeat'; }));

$('toggle').onclick = () => $('panel').classList.toggle('collapsed');

async function geocode() {
  const q = $('address').value.trim();
  if (!q) return;
  status('Recherche de l’adresse…');
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'Accept-Language': 'fr' } });
    const js = await r.json();
    if (!js.length) return status('Adresse introuvable.', true);
    setStart({ lat: +js[0].lat, lng: +js[0].lon });
  } catch (e) { status('Recherche impossible : ' + e.message, true); }
}
$('search').onclick = geocode;
$('address').addEventListener('keydown', (e) => { if (e.key === 'Enter') geocode(); });

$('locate').onclick = () => {
  if (!navigator.geolocation) return status('Géolocalisation indisponible.', true);
  status('Localisation…');
  navigator.geolocation.getCurrentPosition(
    (p) => setStart({ lat: p.coords.latitude, lng: p.coords.longitude }),
    (e) => status('Position refusée : ' + e.message, true),
    { enableHighAccuracy: true, timeout: 10000 });
};

// --- Worker --------------------------------------------------------------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let reqId = 0;
const pending = new Map();
worker.onmessage = (ev) => {
  const m = ev.data;
  const p = pending.get(m.id);
  if (!p) return;
  if (m.type === 'progress') return p.onProgress?.(m);
  pending.delete(m.id);
  if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
};
const call = (msg, onProgress) => new Promise((resolve, reject) => {
  const id = ++reqId;
  pending.set(id, { resolve, reject, onProgress });
  worker.postMessage({ ...msg, id });
});

// Zone déjà chargée (réutilisée si le nouveau calcul y tient)
let area = null;

async function ensureArea(center, radius) {
  if (area && haversine(area.center[0], area.center[1], center[0], center[1]) + radius <= area.radius) return;
  const r = radius * 1.15;
  const bbox = bboxAround(center[0], center[1], r);
  const t0 = performance.now();
  status('Téléchargement des routes et chemins (OpenStreetMap)…');
  let demPct = 0;
  const [osmText, dem] = await Promise.all([
    fetchOsm(bbox, { onStatus: status }),
    loadDem(bbox, browserDecode, { onProgress: (f) => { demPct = Math.round(f * 100); } }),
  ]);
  status(`Construction du graphe… (altitude ${demPct} %)`);
  const built = await call({ type: 'build', osmText, dem, center });
  if (!built.nodes) throw new Error('Aucune voie trouvée dans la zone.');
  area = { center, radius: r };
  console.info(`Zone chargée en ${Math.round(performance.now() - t0)} ms`, built);
}

let results = [], current = 0;

$('go').onclick = async () => {
  if (!start) return status('Place d’abord un point de départ (adresse, 📍 ou toucher la carte).', true);
  let dmin = parseFloat($('dmin').value), dmax = parseFloat($('dmax').value);
  if (!(dmin > 0)) return status('Distance invalide.', true);
  if (!(dmax > dmin)) { dmax = dmin * 1.05; dmin = dmin * 0.95; }
  if (dmax > 60) return status('Distance max : 60 km.', true);
  const mode = val('mode');
  const reps = parseInt($('reps').value, 10) || 0;
  // Rayon de la zone téléchargée : une boucle de D km s'écarte rarement de plus de ~0,3·D du départ.
  const radius = Math.min(Math.max(dmax * 1000 * 0.3, 1200), 8000);
  $('go').disabled = true;
  try {
    await ensureArea(start, radius);
    status('Optimisation du parcours…');
    const res = await call({
      type: 'solve',
      params: {
        startLatLon: start, mode, dmin: dmin * 1000, dmax: dmax * 1000, reps,
        surface: val('surface'), budgetMs: 3000, seed: (Math.random() * 2 ** 31) | 0,
      },
    }, (p) => {
      if (p.phase === 'search' && p.bestUp != null) {
        status(`Optimisation… meilleur : ${(p.bestL / 1000).toFixed(1)} km, D+ ${Math.round(p.bestUp)} m`);
      }
    });
    results = res.result.routes;
    if (!results.length) throw new Error('Aucun parcours trouvé. Essaie une autre distance ou un autre départ.');
    status(`${results.length} proposition(s) en ${(res.result.timeMs / 1000).toFixed(1)} s. Relance « Générer » pour d’autres variantes.`);
    if (window.innerWidth <= 640) $('panel').classList.add('collapsed');
    renderTabs();
    show(0);
  } catch (e) {
    console.error(e);
    status(e.message, true);
  } finally {
    $('go').disabled = false;
  }
};

// --- Résultats -------------------------------------------------------------------
function renderTabs() {
  $('results').hidden = false;
  $('tabs').innerHTML = '';
  results.forEach((r, i) => {
    const b = document.createElement('button');
    b.textContent = `${(r.distance / 1000).toFixed(1)} km · ${Math.round(r.up)} m`;
    b.onclick = () => show(i);
    $('tabs').appendChild(b);
  });
}

let profileGeom = null;

function show(i) {
  current = i;
  const r = results[i];
  [...$('tabs').children].forEach((b, k) => b.classList.toggle('on', k === i));
  routeLayer.clearLayers();
  const pts = Array.from(r.lat, (la, k) => [la, r.lon[k]]);
  const line = L.polyline(pts, { color: getAccent(), weight: 5, opacity: 0.85 }).addTo(routeLayer);
  if (r.kind === 'repeat') {
    const c = r.climb.coords;
    L.polyline(Array.from(c.lat, (la, k) => [la, c.lon[k]]), { color: '#7b2cbf', weight: 7, opacity: 0.9 })
      .bindTooltip(`Côte ×${r.climb.reps}`).addTo(routeLayer);
  }
  const panel = $('panel').getBoundingClientRect();
  const mobile = window.innerWidth <= 640;
  map.fitBounds(line.getBounds(), {
    paddingTopLeft: [mobile ? 20 : panel.right + 20, 20],
    paddingBottomRight: [20, mobile ? window.innerHeight - panel.top + 20 : 20],
  });

  const fmt = (x) => Math.round(x).toLocaleString('fr-FR');
  const cells = [
    ['Distance', `${(r.distance / 1000).toFixed(2)} km`],
    ['D+', `${fmt(r.up)} m`],
    ['D−', `${fmt(r.down)} m`],
    ['Alt. min', `${fmt(r.minEle)} m`],
    ['Alt. max', `${fmt(r.maxEle)} m`],
    ['D+/km', `${fmt(r.up / (r.distance / 1000))} m`],
  ];
  let html = cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  if (r.kind === 'repeat') {
    const c = r.climb;
    html += `<div class="wide"><dt>Côte</dt><dd>${c.reps} × ${fmt(c.length)} m à ${(c.grade * 100).toFixed(1)} % (+${fmt(c.gain)} m), accès ${(c.approach / 1000).toFixed(1)} km</dd></div>`;
  } else if (r.overlap > 0.05) {
    html += `<div class="wide"><dt>Portions empruntées deux fois</dt><dd>${Math.round(r.overlap * 100)} %</dd></div>`;
  }
  $('stats').innerHTML = html;
  profileGeom = drawProfile($('profile'), r);
}

function getAccent() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e4572e';
}

function hoverAt(clientX) {
  const r = results[current];
  if (!r || !profileGeom) return;
  const rect = $('profile').getBoundingClientRect();
  const i = indexAt(r, clientX - rect.left, profileGeom);
  drawProfile($('profile'), r, { hoverIdx: i });
  hoverMarker.setLatLng([r.lat[i], r.lon[i]]).addTo(map);
}
$('profile').addEventListener('pointermove', (e) => hoverAt(e.clientX));
$('profile').addEventListener('pointerdown', (e) => hoverAt(e.clientX));
$('profile').addEventListener('pointerleave', () => {
  hoverMarker.remove();
  if (results[current]) drawProfile($('profile'), results[current]);
});
window.addEventListener('resize', () => { if (results[current]) profileGeom = drawProfile($('profile'), results[current]); });

$('gpx').onclick = () => {
  const r = results[current];
  if (!r) return;
  const label = r.kind === 'repeat' ? `Côte x${r.climb.reps}` : 'Boucle';
  const name = `${label} ${(r.distance / 1000).toFixed(1)} km D+${Math.round(r.up)}`;
  downloadText(toGpx(r, name), `parcours-${(r.distance / 1000).toFixed(1)}km-dplus${Math.round(r.up)}.gpx`);
};

status('Touche la carte, saisis une adresse ou utilise 📍 pour choisir le départ.');
