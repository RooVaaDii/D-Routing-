// Interface : carte, réglages, animation de la recherche, résultats.
import { bboxAround, haversine } from './geo.js';
import { fetchOsm } from './osm.js';
import { loadDem, browserDecode, inFrance, loadIgnDem, validateIgn } from './elevation.js';
import { drawProfile, indexAt } from './profile.js';
import { toGpx, downloadText } from './gpx.js';
import { findCovering, save } from './cache.js';

const $ = (id) => document.getElementById(id);
const L = window.L;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => innerWidth <= 720;
const ACCENT = '#FF4D17', INK = '#111214';
const fmtKm = (m) => (m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtInt = (x) => Math.round(x).toLocaleString('fr-FR');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

// --- Carte -------------------------------------------------------------------
const map = L.map('map', { zoomControl: false, zoomSnap: 0.1 }).setView([48.8566, 2.3522], 13);
if (!isMobile()) L.control.zoom({ position: 'bottomright' }).addTo(map);

// Fond Stadia « Alidade Smooth » (domaine autorisé dans le compte Stadia, sans clé).
// S'il refuse les tuiles, on bascule sur OpenStreetMap désaturé.
const stadia = L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png', {
  maxZoom: 20, crossOrigin: true,
  attribution: '© <a href="https://stadiamaps.com/">Stadia Maps</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, crossOrigin: true, className: 'basemap-osm',
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});
let tileOk = 0, tileErr = 0;
stadia.on('tileload', () => { tileOk++; });
stadia.on('tileerror', () => {
  if (++tileErr >= 4 && tileOk === 0 && map.hasLayer(stadia)) { map.removeLayer(stadia); osm.addTo(map); }
});
stadia.addTo(map);

const ghostLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
let start = null;
const startMarker = L.marker([0, 0], { draggable: true, icon: L.divIcon({ className: 'pin-start', iconSize: [18, 18] }), zIndexOffset: 1000 });
startMarker.on('dragend', () => setStart(startMarker.getLatLng(), { pan: false }));
const cursor = L.marker([0, 0], { icon: L.divIcon({ className: 'pin-cursor', iconSize: [14, 14] }), interactive: false, zIndexOffset: 900 });
map.on('click', (e) => { if (state === 'setup') setStart(e.latlng, { pan: false }); });

function mapPadding() {
  const r = $('sheet').getBoundingClientRect();
  return isMobile()
    ? { paddingTopLeft: [24, 48], paddingBottomRight: [24, innerHeight - r.top + 24] }
    : { paddingTopLeft: [r.right + 40, 40], paddingBottomRight: [40, 40] };
}

// --- États du panneau --------------------------------------------------------------
let state = 'setup';
function setState(s) {
  state = s;
  const sheet = $('sheet');
  sheet.dataset.state = s;
  sheet.classList.remove('peek');
  document.body.classList.toggle('searching', s === 'search');
  for (const v of ['setup', 'search', 'result']) {
    const el = $('view-' + v);
    el.hidden = v !== s;
    if (v === s && !reduceMotion) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
  }
}
$('handle').onclick = () => $('sheet').classList.toggle('peek');
const hint = (msg, err = false) => { $('hint').textContent = msg; $('hint').classList.toggle('error', err); };

// --- Préférences mémorisées (confort uniquement) -----------------------------------
const val = (name) => document.querySelector(`input[name=${name}]:checked`).value;
const check = (name, v) => { const el = document.querySelector(`input[name=${name}][value="${v}"]`); if (el) el.checked = true; };
const prefs = (() => { try { return JSON.parse(localStorage.getItem('dplus-prefs-v2') || '{}'); } catch { return {}; } })();
const savePrefs = () => {
  try {
    localStorage.setItem('dplus-prefs-v2', JSON.stringify({
      dist: $('dist').value, tol: val('tol'), mode: val('mode'), surface: val('surface'), cap: val('cap'), reps,
      stairs: $('stairs').checked, reuse: $('optReuse').checked, street: $('optStreet').checked,
    }));
  } catch { /* stockage indisponible */ }
};

// --- Départ ---------------------------------------------------------------------
async function setStart(ll, { pan = true, label = null } = {}) {
  start = [ll.lat, ll.lng];
  startMarker.setLatLng(ll).addTo(map);
  if (pan) map.flyTo(ll, Math.max(map.getZoom(), 15), { duration: reduceMotion ? 0 : 0.8 });
  $('suggestions').hidden = true;
  hint('');
  preloadSoon();
  if (label) { $('address').value = label; return; }
  $('address').value = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${ll.lat}&lon=${ll.lng}`, { headers: { 'Accept-Language': 'fr' } });
    const js = await r.json();
    if (js?.address && start && start[0] === ll.lat) {
      const a = js.address;
      $('address').value = [a.house_number, a.road || a.pedestrian || a.footway || a.path, a.city || a.town || a.village || a.suburb]
        .filter(Boolean).join(' ') || js.display_name;
    }
  } catch { /* coordonnées affichées */ }
}

$('addressForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('address').value.trim();
  if (!q) return;
  hint('Recherche de l’adresse…');
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'fr' } });
    const res = await r.json();
    if (!res.length) return hint('Adresse introuvable. Ajoute la ville, ou touche la carte.', true);
    hint('');
    if (res.length === 1) return setStart({ lat: +res[0].lat, lng: +res[0].lon }, { label: shortName(res[0]) });
    const ul = $('suggestions');
    ul.innerHTML = '';
    for (const x of res) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.textContent = x.display_name;
      li.onclick = li.onkeydown = (ev) => {
        if (ev.type === 'keydown' && ev.key !== 'Enter') return;
        setStart({ lat: +x.lat, lng: +x.lon }, { label: shortName(x) });
      };
      ul.appendChild(li);
    }
    ul.hidden = false;
  } catch (err) { hint('Recherche impossible : ' + err.message, true); }
});
const shortName = (x) => x.display_name.split(',').slice(0, 3).join(',');

$('locate').onclick = () => {
  if (!navigator.geolocation) return hint('Géolocalisation indisponible sur cet appareil.', true);
  hint('Localisation…');
  navigator.geolocation.getCurrentPosition(
    (p) => setStart({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => hint('Position refusée. Saisis une adresse ou touche la carte.', true),
    { enableHighAccuracy: true, timeout: 10000 });
};

// --- Réglages -----------------------------------------------------------------------
const fmtDec = (x) => x.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
function updateDistance() {
  const d = parseFloat($('dist').value), tol = parseFloat(val('tol'));
  $('distOut').textContent = fmtDec(d);
  $('rangeOut').textContent = `${fmtDec(d * (1 - tol))} – ${fmtDec(d * (1 + tol))} km`;
  const el = $('dist');
  el.style.setProperty('--pct', `${((d - el.min) / (el.max - el.min)) * 100}%`);
}
$('dist').addEventListener('input', updateDistance);
$('dist').addEventListener('change', preloadSoon);
document.querySelectorAll('input[name=tol]').forEach((r) => r.addEventListener('change', () => { updateDistance(); preloadSoon(); }));

let reps = 0;
function showReps() {
  $('repsOut').textContent = reps ? `×${reps}` : 'Auto';
  $('repsHelp').textContent = reps
    ? `Plusieurs côtes, chacune montée ${reps} fois.`
    : 'La meilleure côte du coin, montée autant de fois que la distance le permet.';
}
$('repsMinus').onclick = () => { reps = Math.max(0, reps - 1); showReps(); };
$('repsPlus').onclick = () => { reps = Math.min(20, reps + 1); showReps(); };
const syncMode = () => {
  const rep = val('mode') === 'repeat';
  $('repsRow').hidden = !rep;
  $('loopOpts').hidden = rep;
};
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));

if (prefs.dist) $('dist').value = prefs.dist;
for (const k of ['tol', 'mode', 'surface', 'cap']) if (prefs[k]) check(k, prefs[k]);
if (prefs.reps) reps = prefs.reps;
if (prefs.stairs) $('stairs').checked = true;
if (prefs.reuse === false) $('optReuse').checked = false;
if (prefs.street === false) $('optStreet').checked = false;
updateDistance(); showReps(); syncMode();

// --- Worker ---------------------------------------------------------------------------
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

// --- Chargement du terrain (avec cache et préchargement) -----------------------------------
function step(name, st, text = '') {
  const li = $('steps').querySelector(`[data-step=${name}]`);
  li.classList.toggle('on', st === 'on');
  li.classList.toggle('done', st === 'done');
  li.querySelector('em').textContent = text;
}

const areaRadius = () => {
  const d = parseFloat($('dist').value) * (1 + parseFloat(val('tol')));
  return Math.min(Math.max(d * 1000 * 0.3, 1200), 8000);
};

let area = null;      // zone chargée dans le worker
let loading = null;   // { center, radius, promise }
let demSource = '';

const covers = (z, center, radius) => z && haversine(z.center[0], z.center[1], center[0], center[1]) + radius <= z.radius;

/** Charge (ou réutilise) la zone autour du départ. Partagé par le préchargement et la génération. */
function ensureArea(center, radius) {
  if (covers(area, center, radius)) { for (const s of ['osm', 'dem', 'graph']) step(s, 'done', 'prêt'); return Promise.resolve(); }
  if (loading && covers(loading, center, radius)) return loading.promise;
  const prev = loading?.promise.catch(() => {});
  const z = { center, radius: radius * 1.15 };
  z.promise = (async () => {
    await prev;
    await loadArea(center, z.radius);
    area = z;
  })();
  z.promise.finally(() => { if (loading === z) loading = null; });
  loading = z;
  return z.promise;
}

async function loadArea(center, r) {
  const bbox = bboxAround(center[0], center[1], r);
  const t0 = performance.now();
  step('osm', 'on'); step('dem', 'on'); step('graph', '');

  const osmP = (async () => {
    const hit = await findCovering('osm', bbox);
    if (hit) { step('osm', 'done', 'en cache'); return hit.data; }
    const text = await fetchOsm(bbox, { onStatus: (t) => step('osm', 'on', t.toLowerCase()) });
    step('osm', 'done', `${(text.length / 1e6).toFixed(1)} Mo`);
    save('osm', bbox, text);
    return text;
  })();

  const demP = (async () => {
    const terrarium = await loadDem(bbox, browserDecode, { onProgress: (f) => step('dem', 'on', `${Math.round(f * 100)} %`) });
    if (inFrance(bbox)) {
      let ign = await findCovering('ign', bbox);
      let dem = ign ? { ...ign.data, fallback: terrarium } : null;
      if (!dem) {
        const raw = await loadIgnDem(bbox).catch((e) => { console.warn('IGN indisponible', e); return null; });
        dem = raw && validateIgn(raw, terrarium);
        if (dem) { const { fallback, ...store } = dem; save('ign', bbox, store); }
      }
      if (dem) { demSource = 'IGN RGE ALTI'; step('dem', 'done', ign ? 'IGN · en cache' : 'IGN'); return dem; }
    }
    demSource = 'Terrarium (SRTM)';
    step('dem', 'done', 'SRTM');
    return terrarium;
  })();

  const [osmText, dem] = await Promise.all([osmP, demP]);
  step('graph', 'on');
  const built = await call({ type: 'build', osmText, dem, center });
  if (!built.nodes) throw new Error('Aucune voie praticable dans cette zone.');
  step('graph', 'done', `${fmtInt(built.nodes)} nœuds`);
  console.info(`Zone prête en ${Math.round(performance.now() - t0)} ms`);
}

// Préchargement dès que le départ ou la distance change
let preloadTimer = 0;
function preloadSoon() {
  clearTimeout(preloadTimer);
  if (!start) return;
  preloadTimer = setTimeout(() => {
    if (state !== 'setup' || !start) return;
    const c = start;
    $('preload').textContent = 'Préparation du terrain autour du départ…';
    ensureArea(c, areaRadius())
      .then(() => { if (start === c) $('preload').textContent = 'Terrain prêt.'; })
      .catch(() => { $('preload').textContent = ''; });
  }, 500);
}

// --- Animation de la recherche ---------------------------------------------------------------
const toLatLngs = (c) => { const out = []; for (let i = 0; i < c.length; i += 2) out.push(L.latLng(c[i], c[i + 1])); return out; };

/** Dessine progressivement une ligne (indépendant du zoom : on fait grandir la géométrie). */
function animateLine(line, pts, ms) {
  return new Promise((resolve) => {
    if (reduceMotion || ms <= 0 || pts.length < 2) { line.setLatLngs(pts); return resolve(); }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]));
    const total = cum[cum.length - 1] || 1;
    const t0 = performance.now();
    let i = 1;
    const frame = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const d = total * (1 - Math.pow(1 - k, 2));
      while (i < pts.length - 1 && cum[i] < d) i++;
      const a = pts[i - 1], b = pts[i];
      const f = Math.min(1, Math.max(0, (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
      const head = L.latLng(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f);
      line.setLatLngs([...pts.slice(0, i), head]);
      if (k < 1) requestAnimationFrame(frame); else { line.setLatLngs(pts); resolve(); }
    };
    requestAnimationFrame(frame);
  });
}

function fadeOut(line, ms, remove = true) {
  const el = line.getElement?.();
  if (el && !reduceMotion) {
    el.style.transition = `opacity ${ms}ms ease`;
    requestAnimationFrame(() => { el.style.opacity = '0'; });
  }
  if (remove) setTimeout(() => ghostLayer.removeLayer(line), reduceMotion ? 0 : ms + 50);
}

// File d'attente : les candidats arrivent par paquets, on les dessine à un rythme régulier.
const queue = [];
let pump = 0, alive = 0;
function enqueue(coords) { if (queue.length < 40) queue.push(coords); if (!pump) pump = setInterval(drawNext, 70); }
function drawNext() {
  if (!queue.length) { clearInterval(pump); pump = 0; return; }
  if (alive > 14) return;
  const pts = toLatLngs(queue.shift());
  const line = L.polyline([pts[0]], { color: INK, weight: 1.6, opacity: 0.38, interactive: false, lineJoin: 'round' }).addTo(ghostLayer);
  alive++;
  animateLine(line, pts, 650).then(() => {
    fadeOut(line, 1600);
    setTimeout(() => { alive--; }, 400);
  });
}
async function drainQueue(maxMs) {
  const t0 = performance.now();
  while ((queue.length || alive > 0) && performance.now() - t0 < maxMs) await wait(60);
}

let bestLine = null, bestKey = '';
function showBest(coords) {
  const key = `${coords.length}:${coords[2]}:${coords[coords.length - 3]}`;
  if (key === bestKey) return;
  bestKey = key;
  if (bestLine) fadeOut(bestLine, 500);
  const pts = toLatLngs(coords);
  bestLine = L.polyline([pts[0]], { color: ACCENT, weight: 3, opacity: 0.95, interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(ghostLayer);
  animateLine(bestLine, pts, 700);
}
function clearSearch() { queue.length = 0; clearInterval(pump); pump = 0; ghostLayer.clearLayers(); bestLine = null; bestKey = ''; alive = 0; }

let liveBest = 0;
function setLive(evals, best) {
  $('liveEvals').textContent = fmtInt(evals);
  if (best != null && Math.round(best) > liveBest) { liveBest = Math.round(best); $('liveBest').textContent = `+${fmtInt(best)}`; }
}

// --- Génération ---------------------------------------------------------------------------------
let results = [];
let current = 0;
const BUDGET = 3600;

async function generate() {
  if (!start) return hint('Choisis d’abord un départ : adresse, position, ou touche la carte.', true);
  const d = parseFloat($('dist').value), tol = parseFloat(val('tol'));
  const dmin = d * (1 - tol), dmax = d * (1 + tol);
  const mode = val('mode');
  savePrefs();
  setState('search');
  $('searchTitle').textContent = 'Chargement du terrain';
  $('searchPct').textContent = '';
  step('search', '', '');
  liveBest = 0; setLive(0, null); $('liveBest').textContent = '—'; $('bar').style.width = '0';
  routeLayer.clearLayers(); clearSearch(); cursor.remove();
  // On part serré sur le départ…
  map.flyTo(start, 16, { duration: reduceMotion ? 0 : 0.7 });

  try {
    await ensureArea(start, areaRadius());
    $('searchTitle').textContent = 'Recherche du meilleur parcours';
    step('search', 'on');
    // … puis on dézoome progressivement pendant la recherche.
    const reach = Math.min(dmax * 1000 * 0.32, 8000);
    if (!reduceMotion) {
      map.flyToBounds(L.latLng(start).toBounds(reach * 2), { ...mapPadding(), duration: BUDGET / 1000 + 0.6, easeLinearity: 0.05 });
    }
    let explored = [];
    const params = {
      startLatLon: start, mode, dmin: dmin * 1000, dmax: dmax * 1000, reps: mode === 'repeat' ? reps : 0,
      surface: val('surface'), avoidStairs: $('stairs').checked,
      avoidReuse: $('optReuse').checked, avoidSameStreet: $('optStreet').checked, hillCap: parseInt(val('cap'), 10),
      budgetMs: BUDGET, seed: (Math.random() * 2 ** 31) | 0,
    };
    const res = await call({ type: 'solve', params }, (p) => {
      if (p.phase === 'search') {
        for (const c of p.candidates || []) enqueue(c.coords);
        if (p.best) showBest(p.best.coords);
        setLive(p.evals, p.best?.up);
        const pct = Math.round((p.progress || 0) * 100);
        $('bar').style.width = `${pct}%`;
        $('searchPct').textContent = `${pct} %`;
      } else if (p.phase === 'climbs-explored') explored = p.candidates;
    });
    // Mode « côte » : la recherche est instantanée, on rejoue les côtes examinées.
    if (explored.length && !reduceMotion) {
      const T = 1800, k = explored.length;
      map.flyToBounds(L.latLng(start).toBounds(reach * 2), { ...mapPadding(), duration: T / 1000, easeLinearity: 0.05 });
      for (let i = 0; i < k; i++) {
        enqueue(explored[i].coords);
        setLive(i + 1, explored[i].up);
        $('bar').style.width = `${((i + 1) / k) * 100}%`;
        await wait(T / k);
      }
    }
    await drainQueue(1200);
    results = res.result.routes.sort((a, b) => b.up - a.up);
    if (!results.length) throw new Error('Aucun parcours trouvé ici. Essaie une autre distance, une autre surface ou un autre départ.');
    step('search', 'done', `${(res.result.timeMs / 1000).toFixed(1)} s`);
    $('bar').style.width = '100%';
    queue.length = 0;
    ghostLayer.eachLayer((l) => fadeOut(l, 500, false));
    setTimeout(clearSearch, 550);
    setState('result');
    renderVariants();
    await show(0, true);
  } catch (e) {
    console.error(e);
    clearSearch();
    setState('setup');
    hint(e.message, true);
  }
}

$('go').onclick = () => generate();
$('again').onclick = () => generate();
$('edit').onclick = () => { setState('setup'); hint(''); routeLayer.clearLayers(); cursor.remove(); };

// --- Résultats ----------------------------------------------------------------------------------
function renderVariants() {
  const box = $('variants');
  box.innerHTML = '';
  results.forEach((r, i) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.textContent = `${String.fromCharCode(65 + i)} · +${fmtInt(r.up)} m`;
    b.onclick = () => show(i, true);
    box.appendChild(b);
  });
  box.hidden = results.length < 2;
}

let profileGeom = null, animToken = 0;

async function show(i, animate) {
  current = i;
  const r = results[i];
  [...$('variants').children].forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', k === i); });
  countUp($('rUp'), r.up, (x) => `+${fmtInt(x)}`);
  countUp($('rDist'), r.distance / 1000, (x) => x.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

  const climb = $('rClimb');
  climb.hidden = false;
  if (r.kind === 'repeat') {
    const c = r.climb;
    climb.textContent = `${c.reps} × ${fmtInt(c.length)} m à ${(c.grade * 100).toFixed(1).replace('.', ',')} % (+${fmtInt(c.gain)} m par montée), accès ${fmtKm(c.approach)} km.`;
  } else if (r.kind === 'circuit') {
    climb.textContent = `${r.circuit.length} côte${r.circuit.length > 1 ? 's' : ''} × ${r.circuit[0].reps} : ` +
      r.circuit.map((c) => `${fmtInt(c.length)} m (+${fmtInt(c.gain)} m)`).join(' · ');
  } else climb.hidden = true;

  const facts = [
    ['D−', `${fmtInt(r.down)} m`],
    ['Altitude', `${fmtInt(r.minEle)}–${fmtInt(r.maxEle)} m`],
    ['D+ / km', `${fmtInt(r.up / (r.distance / 1000))} m`],
    r.kind === 'repeat' ? ['Répétitions', `${r.climb.reps}`] : ['Montées', `${r.bigClimbs}`],
  ];
  $('rFacts').innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  const notes = [`Réseau © OpenStreetMap`, `altitude ${demSource}`];
  if (r.kind === 'loop' && r.overlap > 0.05) notes.push(`${Math.round(r.overlap * 100)} % du tracé emprunté deux fois`);
  $('source').textContent = notes.join(' · ');

  const token = ++animToken;
  await drawRoute(r, animate && !reduceMotion, token);
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function countUp(el, to, fmt) {
  if (reduceMotion) { el.textContent = fmt(to); return; }
  const T = 900, t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / T);
    el.textContent = fmt(to * easeOut(k));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function drawRoute(r, animate, token) {
  routeLayer.clearLayers();
  const pts = Array.from(r.lat, (la, k) => L.latLng(la, r.lon[k]));
  const bounds = L.latLngBounds(pts);
  map.flyToBounds(bounds, { ...mapPadding(), duration: animate ? 0.7 : 0 });
  const casing = L.polyline([pts[0]], { color: '#FFFFFF', weight: 9, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
  const line = L.polyline([pts[0]], { color: ACCENT, weight: 4.5, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
  const tops = r.kind === 'repeat' ? [{ top: r.climb.top, label: `×${r.climb.reps}` }]
    : r.kind === 'circuit' ? r.circuit.map((c) => ({ top: c.top, label: `×${c.reps}` })) : [];
  const T = animate ? 1500 : 0;
  if (animate) await wait(700);
  if (token !== animToken) return;
  // Tracé et profil se dessinent ensemble
  const t0 = performance.now();
  const frame = (now) => {
    if (token !== animToken) return;
    const k = T ? Math.min(1, (now - t0) / T) : 1;
    profileGeom = drawProfile($('profile'), r, { reveal: 1 - Math.pow(1 - k, 2) });
    if (k < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await Promise.all([animateLine(casing, pts, T), animateLine(line, pts, T)]);
  if (token !== animToken) return;
  for (const t of tops) {
    L.marker(t.top, { icon: L.divIcon({ className: '', html: `<span class="pin-flag">${t.label}</span>`, iconSize: [0, 0] }), interactive: false }).addTo(routeLayer);
  }
}

// Curseur synchronisé profil ↔ carte
function hoverAt(clientX) {
  const r = results[current];
  if (!r || !profileGeom) return;
  const rect = $('profile').getBoundingClientRect();
  const i = indexAt(r, clientX - rect.left, profileGeom);
  profileGeom = drawProfile($('profile'), r, { hoverIdx: i });
  cursor.setLatLng([r.lat[i], r.lon[i]]).addTo(map);
}
$('profile').addEventListener('pointermove', (e) => hoverAt(e.clientX));
$('profile').addEventListener('pointerdown', (e) => hoverAt(e.clientX));
$('profile').addEventListener('pointerleave', () => {
  cursor.remove();
  if (results[current]) profileGeom = drawProfile($('profile'), results[current]);
});
addEventListener('resize', () => { if (state === 'result' && results[current]) profileGeom = drawProfile($('profile'), results[current]); });

$('gpx').onclick = () => {
  const r = results[current];
  if (!r) return;
  const label = r.kind === 'repeat' ? `Côte x${r.climb.reps}` : r.kind === 'circuit' ? `Côtes x${r.circuit[0].reps}` : 'Boucle';
  const name = `D+ Routing · ${label} ${fmtKm(r.distance)} km +${fmtInt(r.up)} m`;
  downloadText(toGpx(r, name), `dplus-${label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-')}-${(r.distance / 1000).toFixed(1)}km-${Math.round(r.up)}m.gpx`);
};

setState('setup');
hint('Saisis une adresse, utilise ta position ou touche la carte pour placer le départ.');
