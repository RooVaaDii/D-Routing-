// Interface : carte, réglages, animation de la recherche, résultats.
import { bboxAround, haversine } from './geo.js';
import { fetchOsm } from './osm.js';
import { loadDem, browserDecode, inFrance, loadIgnDem, validateIgn } from './elevation.js';
import { drawProfile, indexAt, grades, gradeClass, GRADE_COLORS } from './profile.js';
import { toGpx, downloadText } from './gpx.js';

const $ = (id) => document.getElementById(id);
const L = window.L;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => innerWidth <= 720;
const VARIANT_COLORS = ['#2440FF', '#FF2D8E', '#12B5A6'];
const GHOST_COLORS = ['#2440FF', '#FF2D8E', '#FF4F1A', '#12B5A6', '#FFB000'];
const fmtKm = (m) => (m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtInt = (x) => Math.round(x).toLocaleString('fr-FR');

// --- Carte -------------------------------------------------------------------
const map = L.map('map', { zoomControl: false, renderer: L.svg({ padding: 0.6 }) }).setView([48.8566, 2.3522], 13);
if (!isMobile()) L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 20, subdomains: 'abcd',
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

const ghostLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
let bestLine = null;
let start = null;
const startMarker = L.marker([0, 0], { draggable: true, icon: L.divIcon({ className: 'pin-start', iconSize: [26, 26] }), zIndexOffset: 1000 });
startMarker.on('dragend', () => setStart(startMarker.getLatLng(), { pan: false }));
const cursor = L.marker([0, 0], { icon: L.divIcon({ className: 'pin-cursor', iconSize: [16, 16] }), interactive: false, zIndexOffset: 900 });

map.on('click', (e) => { if (state === 'setup') setStart(e.latlng, { pan: false }); });

// Padding de carte qui tient compte du panneau
function mapPadding() {
  const r = $('sheet').getBoundingClientRect();
  return isMobile()
    ? { paddingTopLeft: [24, 40], paddingBottomRight: [24, innerHeight - r.top + 24] }
    : { paddingTopLeft: [r.right + 32, 32], paddingBottomRight: [32, 32] };
}

// --- États du panneau --------------------------------------------------------------
let state = 'setup';
function setState(s) {
  state = s;
  const sheet = $('sheet');
  sheet.dataset.state = s;
  sheet.classList.remove('peek');
  for (const v of ['setup', 'search', 'result']) {
    const el = $('view-' + v);
    el.hidden = v !== s;
    if (v === s && !reduceMotion) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
  }
}
$('handle').onclick = () => $('sheet').classList.toggle('peek');

const hint = (msg, err = false) => { $('hint').textContent = msg; $('hint').classList.toggle('error', err); };

// --- Préférences mémorisées (confort uniquement) -----------------------------------
const prefs = (() => { try { return JSON.parse(localStorage.getItem('dplus-prefs') || '{}'); } catch { return {}; } })();
const savePrefs = () => {
  try {
    localStorage.setItem('dplus-prefs', JSON.stringify({
      dist: $('dist').value, tol: val('tol'), mode: val('mode'), surface: val('surface'), reps, stairs: $('stairs').checked,
    }));
  } catch { /* stockage indisponible */ }
};
const val = (name) => document.querySelector(`input[name=${name}]:checked`).value;
const check = (name, v) => { const el = document.querySelector(`input[name=${name}][value="${v}"]`); if (el) el.checked = true; };

// --- Départ ---------------------------------------------------------------------
async function setStart(ll, { pan = true, label = null } = {}) {
  start = [ll.lat, ll.lng];
  startMarker.setLatLng(ll).addTo(map);
  if (pan) map.flyTo(ll, Math.max(map.getZoom(), 14), { duration: reduceMotion ? 0 : 0.8 });
  $('suggestions').hidden = true;
  if (label) { $('address').value = label; return; }
  $('address').value = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${ll.lat}&lon=${ll.lng}`, { headers: { 'Accept-Language': 'fr' } });
    const js = await r.json();
    if (js?.address && start && start[0] === ll.lat) {
      const a = js.address;
      $('address').value = [a.house_number, a.road || a.pedestrian || a.footway || a.path, a.city || a.town || a.village || a.suburb]
        .filter(Boolean).join(' ').replace(/^(\d+) /, '$1 ') || js.display_name;
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
    if (!res.length) return hint('Adresse introuvable. Essaie avec la ville, ou touche la carte.', true);
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
    (p) => { hint(''); setStart({ lat: p.coords.latitude, lng: p.coords.longitude }); },
    () => hint('Position refusée. Saisis une adresse ou touche la carte.', true),
    { enableHighAccuracy: true, timeout: 10000 });
};

// --- Réglages -----------------------------------------------------------------------
function updateDistance() {
  const d = parseFloat($('dist').value), tol = parseFloat(val('tol'));
  $('distOut').textContent = d.toLocaleString('fr-FR');
  $('rangeOut').textContent = `${(d * (1 - tol)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} – ${(d * (1 + tol)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} KM`;
  const el = $('dist');
  el.style.setProperty('--pct', `${((d - el.min) / (el.max - el.min)) * 100}%`);
}
$('dist').addEventListener('input', updateDistance);
document.querySelectorAll('input[name=tol]').forEach((r) => r.addEventListener('change', updateDistance));

let reps = 0;
const showReps = () => { $('repsOut').textContent = reps ? `${reps}` : 'AUTO'; };
$('repsMinus').onclick = () => { reps = Math.max(0, reps - 1); showReps(); };
$('repsPlus').onclick = () => { reps = Math.min(40, reps + 1); showReps(); };
const syncMode = () => { $('repsRow').hidden = val('mode') !== 'repeat'; };
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));

// Restaure les préférences
if (prefs.dist) $('dist').value = prefs.dist;
if (prefs.tol) check('tol', prefs.tol);
if (prefs.mode) check('mode', prefs.mode);
if (prefs.surface) check('surface', prefs.surface);
if (prefs.reps) reps = prefs.reps;
if (prefs.stairs) $('stairs').checked = true;
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

// --- Étapes de chargement ----------------------------------------------------------------
function step(name, st, text = '') {
  const li = $('steps').querySelector(`[data-step=${name}]`);
  li.classList.toggle('on', st === 'on');
  li.classList.toggle('done', st === 'done');
  li.querySelector('em').textContent = text;
}

let area = null; // zone déjà chargée, réutilisée si le nouveau calcul y tient
let demSource = '';

async function ensureArea(center, radius) {
  if (area && haversine(area.center[0], area.center[1], center[0], center[1]) + radius <= area.radius) {
    for (const s of ['osm', 'dem', 'graph']) step(s, 'done', 'EN CACHE');
    return;
  }
  const r = radius * 1.15;
  const bbox = bboxAround(center[0], center[1], r);
  step('osm', 'on'); step('dem', 'on', inFrance(bbox) ? 'IGN' : 'SRTM');
  const osmP = fetchOsm(bbox, { onStatus: (t) => step('osm', 'on', t) }).then((t) => { step('osm', 'done', `${(t.length / 1e6).toFixed(1)} MO`); return t; });
  const terrP = loadDem(bbox, browserDecode, { onProgress: (f) => step('dem', 'on', `${Math.round(f * 100)} %`) });
  const ignP = inFrance(bbox) ? loadIgnDem(bbox).catch((e) => { console.warn('IGN indisponible', e); return null; }) : Promise.resolve(null);
  const demP = Promise.all([terrP, ignP]).then(([terrarium, ign]) => {
    const ignDem = ign && validateIgn(ign, terrarium);
    demSource = ignDem ? 'IGN RGE ALTI (sol nu)' : 'Terrarium (SRTM)';
    step('dem', 'done', ignDem ? 'IGN' : 'SRTM');
    return ignDem || terrarium;
  });
  const [osmText, dem] = await Promise.all([osmP, demP]);
  step('graph', 'on');
  const built = await call({ type: 'build', osmText, dem, center });
  if (!built.nodes) throw new Error('Aucune voie praticable dans cette zone.');
  step('graph', 'done', `${fmtInt(built.nodes)} NŒUDS`);
  area = { center, radius: r };
}

// --- Animation de la recherche ---------------------------------------------------------------
const toLatLngs = (c) => { const out = []; for (let i = 0; i < c.length; i += 2) out.push([c[i], c[i + 1]]); return out; };
let ghostCount = 0;
function addGhost(coords, color) {
  const line = L.polyline(toLatLngs(coords), { color, weight: 2.5, opacity: 0.75, interactive: false, className: 'ghost' }).addTo(ghostLayer);
  ghostCount++;
  if (reduceMotion) { setTimeout(() => ghostLayer.removeLayer(line), 300); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => { const el = line.getElement(); if (el) el.style.opacity = '0'; }));
  setTimeout(() => ghostLayer.removeLayer(line), 1400);
}
function showBest(coords) {
  const ll = toLatLngs(coords);
  if (!bestLine) bestLine = L.polyline(ll, { color: '#0D1015', weight: 4, opacity: 0.9, interactive: false, dashArray: '1 7', lineCap: 'round' }).addTo(ghostLayer);
  else bestLine.setLatLngs(ll);
}
function clearSearchLayers() { ghostLayer.clearLayers(); bestLine = null; }

let liveBest = 0;
function setLive(evals, best) {
  $('liveEvals').textContent = fmtInt(evals);
  if (best != null && Math.round(best) !== liveBest) {
    liveBest = Math.round(best);
    $('liveBest').textContent = `+${fmtInt(best)}`;
  }
}

// Rejoue les côtes examinées (mode répétitions) à un rythme lisible
function playExplored(cands) {
  return new Promise((resolve) => {
    if (reduceMotion || !cands.length) return resolve();
    let i = 0;
    const tick = () => {
      if (i >= cands.length) return setTimeout(resolve, 250);
      const c = cands[i];
      addGhost(c.coords, GHOST_COLORS[i % GHOST_COLORS.length]);
      setLive(i + 1, Math.max(liveBest, c.up));
      $('bar').style.width = `${((i + 1) / cands.length) * 100}%`;
      i++;
      setTimeout(tick, 110);
    };
    tick();
  });
}

// --- Génération ---------------------------------------------------------------------------------
let results = [], current = 0, lastParams = null;

async function generate(sameArea = false) {
  if (!start) return hint('Choisis d’abord un départ : adresse, position ou touche la carte.', true);
  const d = parseFloat($('dist').value), tol = parseFloat(val('tol'));
  const dmin = d * (1 - tol), dmax = d * (1 + tol);
  const mode = val('mode');
  savePrefs();
  setState('search');
  $('searchTitle').textContent = 'CHARGEMENT DU TERRAIN';
  for (const s of ['osm', 'dem', 'graph', 'search']) step(s, '', '');
  liveBest = 0; setLive(0, null); $('liveBest').textContent = '—'; $('bar').style.width = '0';
  routeLayer.clearLayers(); clearSearchLayers(); cursor.remove();
  // Cadre la zone explorée
  const reach = Math.min(dmax * 1000 * 0.3, 8000);
  map.flyToBounds(L.latLng(start).toBounds(reach * 2), { ...mapPadding(), duration: reduceMotion ? 0 : 0.9 });

  try {
    const radius = Math.min(Math.max(dmax * 1000 * 0.3, 1200), 8000);
    await ensureArea(start, radius);
    $('searchTitle').textContent = 'RECHERCHE DU MEILLEUR PARCOURS';
    step('search', 'on');
    let explored = [];
    lastParams = {
      startLatLon: start, mode, dmin: dmin * 1000, dmax: dmax * 1000, reps: mode === 'repeat' ? reps : 0,
      surface: val('surface'), avoidStairs: $('stairs').checked, budgetMs: 3200, seed: (Math.random() * 2 ** 31) | 0,
    };
    let k = 0;
    const res = await call({ type: 'solve', params: lastParams }, (p) => {
      if (p.phase === 'search') {
        for (const c of p.candidates || []) addGhost(c.coords, GHOST_COLORS[k++ % GHOST_COLORS.length]);
        if (p.best) { showBest(p.best.coords); }
        setLive(p.evals, p.best?.up);
        $('bar').style.width = `${Math.round((p.progress || 0) * 100)}%`;
      } else if (p.phase === 'climbs-explored') explored = p.candidates;
    });
    if (explored.length) await playExplored(explored);
    results = res.result.routes.sort((a, b) => b.up - a.up);
    if (!results.length) throw new Error('Aucun parcours trouvé ici. Essaie une autre distance, une autre surface ou un autre départ.');
    step('search', 'done', `${(res.result.timeMs / 1000).toFixed(1)} S`);
    $('bar').style.width = '100%';
    await wait(reduceMotion ? 0 : 250);
    // Les fantômes s'effacent, le gagnant se dessine
    ghostLayer.eachLayer((l) => { const el = l.getElement?.(); if (el) { el.classList.add('ghost'); el.style.opacity = '0'; } });
    setTimeout(clearSearchLayers, 900);
    setState('result');
    renderVariants();
    show(0, true);
  } catch (e) {
    console.error(e);
    clearSearchLayers();
    setState('setup');
    hint(e.message, true);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

$('go').onclick = () => generate();
$('again').onclick = () => generate(true);
$('edit').onclick = () => { setState('setup'); hint(''); };

// --- Résultats ----------------------------------------------------------------------------------
function renderVariants() {
  const box = $('variants');
  box.innerHTML = '';
  results.forEach((r, i) => {
    const b = document.createElement('button');
    b.style.setProperty('--c', VARIANT_COLORS[i]);
    b.innerHTML = `<span class="mono"><i></i>${String.fromCharCode(65 + i)} · ${fmtKm(r.distance)} KM</span><b>+${fmtInt(r.up)}</b>`;
    b.onclick = () => show(i, true);
    box.appendChild(b);
  });
  box.hidden = results.length < 2;
}

let profileGeom = null;
let animToken = 0;

function show(i, animate) {
  current = i;
  const r = results[i];
  [...$('variants').children].forEach((b, k) => b.classList.toggle('on', k === i));
  drawRoute(r, animate && !reduceMotion);

  countUp($('rUp'), r.up, (x) => `+${fmtInt(x)}`);
  countUp($('rDist'), r.distance / 1000, (x) => x.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  if (r.kind === 'repeat') {
    const c = r.climb;
    $('rClimb').hidden = false;
    $('rClimb').textContent = `${c.reps} × ${fmtInt(c.length)} M À ${(c.grade * 100).toFixed(1).replace('.', ',')} % · +${fmtInt(c.gain)} M PAR MONTÉE · ACCÈS ${fmtKm(c.approach)} KM`;
  } else $('rClimb').hidden = true;
  const facts = [
    ['D−', `${fmtInt(r.down)} M`],
    ['ALTITUDE', `${fmtInt(r.minEle)}–${fmtInt(r.maxEle)} M`],
    ['D+ / KM', `${fmtInt(r.up / (r.distance / 1000))} M`],
    r.kind === 'repeat' ? ['RÉPÉTITIONS', `${r.climb.reps}`] : ['MONTÉES', `${r.bigClimbs}`],
  ];
  $('rFacts').innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('source').textContent = `Réseau © OpenStreetMap · Altitude : ${demSource}${r.overlap > 0.05 ? ` · ${Math.round(r.overlap * 100)} % du tracé emprunté deux fois` : ''}`;

  // Profil qui se révèle en même temps que le tracé
  const token = ++animToken;
  const T = animate && !reduceMotion ? 1300 : 0;
  const t0 = performance.now();
  const frame = (now) => {
    if (token !== animToken) return;
    const k = T ? Math.min(1, (now - t0) / T) : 1;
    profileGeom = drawProfile($('profile'), r, { reveal: easeOut(k) });
    if (k < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function countUp(el, to, fmt) {
  if (reduceMotion) { el.textContent = fmt(to); return; }
  const from = 0, T = 900, t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / T);
    el.textContent = fmt(from + (to - from) * easeOut(k));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function drawRoute(r, animate) {
  routeLayer.clearLayers();
  const pts = Array.from(r.lat, (la, k) => [la, r.lon[k]]);
  const g = r._grades || (r._grades = grades(r));
  // Liseré blanc puis segments colorés selon la pente
  const casing = L.polyline(pts, { color: '#FFFFFF', weight: 11, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(routeLayer);
  const segs = [];
  let from = 0, cls = gradeClass(g[0]);
  for (let i = 1; i <= pts.length; i++) {
    const c = i < pts.length ? gradeClass(g[i]) : -1;
    if (c !== cls || i === pts.length) {
      const seg = pts.slice(from, Math.min(i + 1, pts.length));
      if (seg.length > 1) {
        segs.push({ line: L.polyline(seg, { color: GRADE_COLORS[cls], weight: 5.5, opacity: 1, interactive: false, lineCap: 'round', lineJoin: 'round', className: 'route-seg' }).addTo(routeLayer), d0: r.dist[from], d1: r.dist[Math.min(i, pts.length - 1)] });
      }
      from = i; cls = c;
    }
  }
  // Repères
  if (r.kind === 'repeat') {
    L.marker(r.climb.top, { icon: L.divIcon({ className: '', html: `<span class="pin-flag">SOMMET ×${r.climb.reps}</span>`, iconSize: [0, 0] }), interactive: false }).addTo(routeLayer);
  }
  map.flyToBounds(casing.getBounds(), { ...mapPadding(), duration: animate ? 0.8 : 0 });
  if (!animate) return;
  const T = 1.3, D = r.distance || 1;
  const cel = casing.getElement();
  if (cel) { cel.style.opacity = '0'; cel.style.transition = 'opacity .6s ease .2s'; requestAnimationFrame(() => { cel.style.opacity = '1'; }); }
  // Attente de la fin du vol de carte pour que les longueurs SVG soient justes
  setTimeout(() => {
    for (const s of segs) {
      const el = s.line.getElement();
      if (!el) continue;
      const len = el.getTotalLength();
      el.style.transition = 'none';
      el.style.strokeDasharray = `${len} ${len}`;
      el.style.strokeDashoffset = `${len}`;
      el.getBoundingClientRect();
      el.style.transition = '';
      el.style.setProperty('--d', `${((s.d1 - s.d0) / D) * T}s`);
      el.style.setProperty('--delay', `${(s.d0 / D) * T}s`);
      requestAnimationFrame(() => { el.style.strokeDashoffset = '0'; });
    }
    setTimeout(() => {
      for (const s of segs) { const el = s.line.getElement(); if (el) { el.style.strokeDasharray = ''; el.style.strokeDashoffset = ''; } }
    }, T * 1000 + 200);
  }, 820);
}

// Curseur synchronisé profil ↔ carte
function hoverAt(clientX) {
  const r = results[current];
  if (!r || !profileGeom) return;
  animToken++;
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
  const label = r.kind === 'repeat' ? `Côte x${r.climb.reps}` : 'Boucle';
  const name = `D+ Routing · ${label} ${fmtKm(r.distance)} km +${fmtInt(r.up)} m`;
  downloadText(toGpx(r, name), `dplus-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(r.distance / 1000).toFixed(1)}km-${Math.round(r.up)}m.gpx`);
};

setState('setup');
hint('Saisis une adresse, utilise ta position ou touche la carte pour placer le départ.');
