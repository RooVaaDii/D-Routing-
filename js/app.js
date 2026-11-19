// Interface : carte, réglages, animation de la recherche, résultats.
import { bboxAround, haversine } from './geo.js';
import { fetchOsm } from './osm.js';
import { loadDem, browserDecode, inFrance, loadIgnDem, validateIgn } from './elevation.js';
import { drawProfile, indexAt } from './profile.js';
import { toGpx, downloadText } from './gpx.js';
import { findCovering, save, onCacheEvent } from './cache.js';
import { diag } from './diag.js';
import { maplibregl, createMap, tokens, RevealLine, TerrainFx, interleavedToLngLat, tween } from './map.js';

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => innerWidth <= 720;
const T = tokens();
const fmtKm = (m) => (m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtInt = (x) => Math.round(x).toLocaleString('fr-FR');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Rejette avec un message clair si la promesse n'aboutit pas à temps (rien ne doit bloquer). */
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((e) => diag.log(`service worker : ${e.message}`));
onCacheEvent((e) => diag.log(`cache ${e.kind} ${e.op} : ${e.ok ? e.note || 'ok' : 'échec, on continue sans (' + e.note + ')'} en ${Math.round(e.ms)} ms`));

// --- Carte -------------------------------------------------------------------
const map = createMap('map', { center: [2.3522, 48.8566], zoom: 13 });
const mapReady = new Promise((resolve) => map.once('load', resolve));
let mapLoaded = false;
mapReady.then(() => { mapLoaded = true; });
// La carte n'est qu'un décor : si elle tarde (réseau, WebGL), le calcul continue sans elle.
const mapOrTimeout = () => Promise.race([mapReady, wait(4000)]);
map.on('error', (e) => diag.log(`carte : ${e.error?.message || 'erreur'}`));
const llOf = (lat, lon) => [lon, lat];

const pin = (cls, html = '') => { const el = document.createElement('div'); el.className = cls; el.innerHTML = html; return el; };
let start = null;
const startEl = pin('pin-start');
startEl.setAttribute('aria-label', 'Départ (déplaçable)');
const startMarker = new maplibregl.Marker({ element: startEl, draggable: true });
startMarker.on('dragend', () => setStart(startMarker.getLngLat(), { pan: false }));
const cursor = new maplibregl.Marker({ element: pin('pin-cursor') });
const meMarker = new maplibregl.Marker({ element: pin('pin-me') });
let flags = [];
map.on('click', (e) => { if (state === 'setup') setStart(e.lngLat, { pan: false }); });

/** Zone de la carte non couverte par le panneau (pixels). */
function visibleBox() {
  const r = $('sheet').getBoundingClientRect();
  return isMobile() ? { left: 0, top: 0, right: innerWidth, bottom: r.top } : { left: r.right, top: 0, right: innerWidth, bottom: innerHeight };
}
/** Centre un point dans la zone visible : décalage par rapport au centre de la carte. */
function visibleOffset() {
  const b = visibleBox();
  return [(b.left + b.right) / 2 - innerWidth / 2, (b.top + b.bottom) / 2 - innerHeight / 2];
}
function flyToVisible(lngLat, zoom, duration = 800) {
  map.flyTo({ center: lngLat, zoom, offset: visibleOffset(), duration: reduceMotion ? 0 : duration });
}
function mapPadding() {
  const r = $('sheet').getBoundingClientRect();
  return isMobile()
    ? { top: 56, left: 24, right: 24, bottom: innerHeight - r.top + 24 }
    : { top: 40, left: r.right + 40, right: 40, bottom: 40 };
}
const boundsAround = ([lat, lon], r) => {
  const dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
  return [[lon - dLon, lat - dLat], [lon + dLon, lat + dLat]];
};

// Couches animées (créées quand le style est prêt)
let fx = null, ghosts = [], bests = [], alts = [], route = null;
const GHOSTS = 18;          // options testées gardées à l'écran pendant la recherche
const ALT_OPACITY = 0.4;    // variantes non sélectionnées, en fin sur la carte
mapReady.then(() => {
  fx = new TerrainFx(map, T, { reduceMotion });
  for (let i = 0; i < GHOSTS; i++) ghosts.push(Object.assign(new RevealLine(map, `ghost-${i}`, { color: T.ink, width: 1.5, opacity: 0.5 }), { busy: false, shown: false, t: 0 }));
  for (let i = 0; i < 2; i++) bests.push(new RevealLine(map, `best-${i}`, { color: T.accent, width: 3, opacity: 0.95 }));
  for (let i = 0; i < 3; i++) alts.push(new RevealLine(map, `alt-${i}`, { color: T.ink, width: 2.2, opacity: 0.7, casing: { color: T.bg, width: 5 } }));
  route = new RevealLine(map, 'route', { color: T.accent, width: 4.5, casing: { color: T.bg, width: 9 } });
});

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
    if (v === s) el.scrollTop = 0;
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
      dist: $('dist').value, up: $('up').value, goal: val('goal'), tol: val('tol'), mode: val('mode'), surface: val('surface'), cap: val('cap'), reps,
      stairs: $('stairs').checked, reuse: $('optReuse').checked, street: $('optStreet').checked,
    }));
  } catch { /* stockage indisponible */ }
};

// --- Départ ---------------------------------------------------------------------
async function setStart(ll, { pan = true, label = null } = {}) {
  start = [ll.lat, ll.lng];
  startMarker.setLngLat([ll.lng, ll.lat]).addTo(map);
  if (pan) flyToVisible([ll.lng, ll.lat], Math.max(map.getZoom(), 15));
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

// Géolocalisation : place directement le départ sur ma position
function locateMe() {
  if (!navigator.geolocation) return hint('Géolocalisation indisponible sur cet appareil.', true);
  if (state !== 'setup') setState('setup');
  $('geoBtn').classList.add('busy');
  hint('Localisation…');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      $('geoBtn').classList.remove('busy');
      const ll = { lat: p.coords.latitude, lng: p.coords.longitude };
      meMarker.setLngLat([ll.lng, ll.lat]).addTo(map);
      clearRoute();
      setStart(ll);
    },
    (err) => {
      $('geoBtn').classList.remove('busy');
      hint(err.code === 1 ? 'Localisation refusée : autorise-la dans les réglages du navigateur, ou touche la carte.' : 'Position introuvable pour le moment. Réessaie ou touche la carte.', true);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
}
$('locate').onclick = locateMe;
$('geoBtn').onclick = locateMe;

// --- Réglages -----------------------------------------------------------------------
const fmtDec = (x) => x.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
const goalIsUp = () => val('goal') === 'up';
const setPct = (el) => el.style.setProperty('--pct', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
/** Objectif dénivelé : distance maximale explorée (estimation prudente, ~18 m de D+ par km). */
const upMaxKm = () => Math.min(42, Math.max(4, parseFloat($('up').value) / 18));
function updateGoal() {
  const tol = parseFloat(val('tol')), up = goalIsUp();
  $('goalDist').hidden = up;
  $('goalUp').hidden = !up;
  $('tolLabel').textContent = up ? 'Marge sur le dénivelé' : 'Marge sur la distance';
  if (up) {
    const u = parseFloat($('up').value);
    $('upOut').textContent = `+${fmtInt(u)}`;
    $('rangeOut').textContent = `entre ${fmtInt(u * (1 - tol))} et ${fmtInt(u * (1 + tol))} m`;
  } else {
    const d = parseFloat($('dist').value);
    $('distOut').textContent = fmtDec(d);
    $('rangeOut').textContent = `entre ${fmtDec(d * (1 - tol))} et ${fmtDec(d * (1 + tol))} km`;
  }
  setPct($('dist')); setPct($('up'));
}
for (const id of ['dist', 'up']) {
  $(id).addEventListener('input', updateGoal);
  $(id).addEventListener('change', preloadSoon);
}
document.querySelectorAll('input[name=tol], input[name=goal]').forEach((r) => r.addEventListener('change', () => { updateGoal(); preloadSoon(); }));

let reps = 0;
function showReps() {
  $('repsOut').textContent = reps ? `×${reps}` : 'Auto';
  $('repsHelp').textContent = reps
    ? `Un circuit de plusieurs côtes, chacune montée ${reps} fois.`
    : goalIsUp()
      ? 'La meilleure côte du coin, montée autant de fois qu’il faut pour atteindre le dénivelé.'
      : 'La meilleure côte du coin, montée autant de fois que la distance le permet.';
}
$('repsMinus').onclick = () => { reps = Math.max(0, reps - 1); showReps(); };
$('repsPlus').onclick = () => { reps = Math.min(20, reps + 1); showReps(); };
const syncMode = () => {
  const rep = val('mode') === 'repeat';
  $('repsRow').hidden = !rep;
  $('loopOpts').hidden = rep;
  $('modeHelp').textContent = rep
    ? 'Une séance : monter et redescendre une ou plusieurs côtes.'
    : 'Une boucle qui enchaîne les meilleures montées du coin.';
  showReps();
};
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));
document.querySelectorAll('input[name=goal]').forEach((r) => r.addEventListener('change', showReps));

if (prefs.dist) $('dist').value = prefs.dist;
if (prefs.up) $('up').value = prefs.up;
for (const k of ['goal', 'tol', 'mode', 'surface', 'cap']) if (prefs[k]) check(k, prefs[k]);
if (prefs.reps) reps = prefs.reps;
if (prefs.stairs) $('stairs').checked = true;
if (prefs.reuse === false) $('optReuse').checked = false;
if (prefs.street === false) $('optStreet').checked = false;
updateGoal(); syncMode();

// --- Worker ---------------------------------------------------------------------------
// Si le worker plante (mémoire sur iPhone) ou ne répond plus, on le recrée : le graphe est
// alors perdu et la zone sera rechargée (depuis le cache local si possible).
let worker = null, reqId = 0;
const pending = new Map();
function startWorker(reason) {
  if (worker) {
    worker.terminate();
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
    area = null; loading = null;
    diag.log(`worker redémarré : ${reason}`);
  }
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') return p.onProgress?.(m);
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
  };
  worker.onerror = (e) => { e.preventDefault?.(); startWorker(`le calcul s'est arrêté (${e.message || 'erreur'}). Réessaie.`); };
}
startWorker();
/** Appel au worker, avec délai maximal : au-delà, le worker est recréé et l'appel échoue. */
const call = (msg, onProgress, ms, msgTimeout) => new Promise((resolve, reject) => {
  const id = ++reqId;
  const timer = setTimeout(() => startWorker(msgTimeout), ms);
  const done = (f) => (x) => { clearTimeout(timer); f(x); };
  pending.set(id, { resolve: done(resolve), reject: done(reject), onProgress });
  worker.postMessage({ ...msg, id });
});

// --- Chargement du terrain (avec cache et préchargement) -----------------------------------
const STEP_LABEL = { osm: 'Réseau OpenStreetMap', dem: 'Altitudes', graph: 'Graphe', search: 'Recherche' };
const stepT = {}; // début de l'étape en cours (ms), pour le suivi de l'attente
function step(name, st, text = '') {
  if (st === 'on' && !stepT[name]) stepT[name] = performance.now();
  if (st !== 'on' && stepT[name]) {
    diag.log(`${STEP_LABEL[name]} : ${((performance.now() - stepT[name]) / 1000).toFixed(1)} s${text ? ` (${text})` : ''}`);
    delete stepT[name];
  }
  const li = $('steps').querySelector(`[data-step=${name}]`);
  li.classList.toggle('on', st === 'on');
  li.classList.toggle('done', st === 'done');
  li.querySelector('em').textContent = text;
}

const areaRadius = () => {
  const d = goalIsUp() ? upMaxKm() : parseFloat($('dist').value) * (1 + parseFloat(val('tol')));
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
  // Une zone plus grande ou ailleurs est demandée : l'ancien téléchargement est annulé tout de
  // suite (sinon les requêtes s'empilent et les serveurs Overpass nous font attendre).
  if (loading) { loading.ctrl.abort(); diag.log('téléchargement précédent annulé : nouvelle zone'); }
  const z = { center, radius: radius * 1.15, ctrl: new AbortController() };
  z.promise = (async () => {
    await loadArea(center, z.radius, z.ctrl.signal);
    if (z.ctrl.signal.aborted) throw new DOMException('Zone remplacée', 'AbortError');
    area = z;
  })();
  z.promise.finally(() => { if (loading === z) loading = null; }).catch(() => {});
  loading = z;
  return z.promise;
}

/** Plage d'altitude utile d'une grille (2e – 98e centile), pour la teinte du relief. */
function elevRange(dem) {
  const d = dem.data, stride = Math.max(1, Math.floor(d.length / 20000)), a = [];
  for (let i = 0; i < d.length; i += stride) if (Number.isFinite(d[i])) a.push(d[i]);
  a.sort((x, y) => x - y);
  return a.length ? [a[Math.floor(a.length * 0.02)], a[Math.floor(a.length * 0.98)]] : [0, 100];
}

async function loadArea(center, r, signal) {
  const live = () => !signal.aborted; // zone toujours d'actualité ?
  const bbox = bboxAround(center[0], center[1], r);
  const t0 = performance.now();
  step('osm', 'on'); live() && step('dem', 'on'); step('graph', '');
  fx?.begin(center, r);

  const osmP = (async () => {
    const hit = await findCovering('osm', bbox);
    if (hit) { step('osm', 'done', 'en cache'); fx?.network(hit.data); return hit.data; }
    const text = await fetchOsm(bbox, { signal, onStatus: (t) => { if (!signal.aborted) step('osm', 'on', t.toLowerCase()); } });
    step('osm', 'done', `${(text.length / 1e6).toFixed(1)} Mo`);
    fx?.network(text);
    save('osm', bbox, text);
    return text;
  })();

  const demP = (async () => {
    await wait(0);
    if (!live()) throw new DOMException('Zone remplacée', 'AbortError');
    const terrarium = await withTimeout(
      loadDem(bbox, browserDecode, { onProgress: (f) => { live() && step('dem', 'on', `${Math.round(f * 100)} %`); if (live()) fx?.setRelief(f * 0.9); } }),
      60000, 'Les altitudes (Terrarium) ne répondent pas. Vérifie la connexion et réessaie.');
    if (live()) fx?.setRange(...elevRange(terrarium));
    if (inFrance(bbox)) {
      let ign = await findCovering('ign', bbox);
      let dem = ign ? { ...ign.data, fallback: terrarium } : null;
      if (!dem) {
        if (!live()) return terrarium; // zone remplacée : inutile de télécharger l'IGN
        step('dem', 'on', 'IGN');
        const raw = await withTimeout(loadIgnDem(bbox), 20000, 'IGN : délai dépassé')
          .catch((e) => { diag.log(`IGN indisponible, repli Terrarium (${e.message})`); return null; });
        dem = raw && validateIgn(raw, terrarium);
        if (dem) { const { fallback, ...store } = dem; save('ign', bbox, store); }
      }
      if (dem) { demSource = 'IGN RGE ALTI'; live() && step('dem', 'done', ign ? 'IGN · en cache' : 'IGN'); return dem; }
    }
    demSource = 'Terrarium (SRTM)';
    live() && step('dem', 'done', 'SRTM');
    return terrarium;
  })();

  const [osmText, dem] = await Promise.all([osmP, demP]);
  if (signal.aborted) throw new DOMException('Zone remplacée', 'AbortError');
  fx?.setRelief(1);
  step('graph', 'on');
  const built = await call({ type: 'build', osmText, dem, center }, null, 120000,
    'La préparation du graphe prend trop de temps. Essaie une distance plus courte.');
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
      .then(() => { if (start === c) $('preload').textContent = 'Terrain prêt.'; if (state === 'setup') fx?.clear(900); })
      .catch((e) => { if (e.name === 'AbortError') return; $('preload').textContent = ''; fx?.clear(); });
  }, 500);
}

// --- Animation de la recherche ---------------------------------------------------------------
let searchToken = 0;
const easeOut2 = (t) => 1 - Math.pow(1 - t, 2);

/** Dévoile une ligne sur ms millisecondes (le dégradé avance, la géométrie ne bouge pas). */
async function revealLine(line, coords, ms, token = searchToken) {
  await line.set(coords);
  if (reduceMotion || ms <= 0) { line.show(1); return true; }
  return tween(ms, (k) => line.show(k), { ease: easeOut2, alive: () => token === searchToken });
}

// File d'attente : les candidats arrivent par paquets, on les dessine à un rythme régulier.
// Ils restent affichés (en fin) et s'accumulent ; les plus anciens laissent la place.
const queue = [];
let pump = 0, alive = 0;
function enqueue(coords) { if (queue.length < 40) queue.push(coords); if (!pump) pump = setInterval(drawNext, 70); }
function drawNext() {
  if (!queue.length) { clearInterval(pump); pump = 0; return; }
  if (alive >= 4) return;
  const token = searchToken;
  const coords = interleavedToLngLat(queue.shift());
  const run = (slot) => {
    if (token !== searchToken) return;
    revealLine(slot, coords, 650, token).then((done) => {
      alive = Math.max(0, alive - 1);
      if (!done || token !== searchToken) return;
      slot.fade(0.2, reduceMotion ? 0 : 900);
      Object.assign(slot, { busy: false, shown: true, t: performance.now() });
    });
  };
  let slot = ghosts.find((g) => !g.busy && !g.shown);
  alive++;
  if (slot) { slot.busy = true; run(slot); return; }
  // Toutes les places sont prises : la plus ancienne option s'efface.
  slot = ghosts.filter((g) => !g.busy).sort((p, q) => p.t - q.t)[0];
  if (!slot) { alive--; queue.unshift(coords.flatMap(([lo, la]) => [la, lo])); return; }
  slot.busy = true; slot.shown = false;
  slot.fade(0, reduceMotion ? 0 : 220);
  setTimeout(() => run(slot), reduceMotion ? 0 : 240);
}
async function drainQueue(maxMs) {
  const t0 = performance.now();
  while ((queue.length || alive > 0) && performance.now() - t0 < maxMs) await wait(60);
}

/**
 * Fin de recherche : les options testées s'éliminent une à une pendant que les trois
 * parcours retenus se dessinent ; il ne reste qu'eux.
 */
async function eliminate(routes) {
  queue.length = 0; clearInterval(pump); pump = 0;
  if (!alts.length) return; // carte pas encore prête : pas d'animation
  const shown = [...ghosts.filter((g) => g.shown || g.busy), ...bests];
  for (let i = shown.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shown[i], shown[j]] = [shown[j], shown[i]]; }
  const gap = reduceMotion ? 0 : Math.min(70, 1100 / Math.max(1, shown.length));
  shown.forEach((g, i) => g.fade(0, reduceMotion ? 0 : 300, 150 + i * gap));
  const token = ++altToken;
  routes.slice(0, 3).forEach((r, k) => {
    const coords = Array.from(r.lat, (la, j) => [r.lon[j], la]);
    setTimeout(() => {
      if (token !== altToken) return;
      alts[k].set(coords).then(() => tween(reduceMotion ? 0 : 900, (x) => alts[k].show(x), { ease: easeOut2, alive: () => token === altToken }));
    }, reduceMotion ? 0 : 250 + k * 200);
  });
  await wait(reduceMotion ? 0 : Math.max(150 + shown.length * gap + 300, 250 + 2 * 200 + 900) + 150);
}
let altToken = 0;

let bestKey = '', bestIdx = 0;
function showBest(coords) {
  const key = `${coords.length}:${coords[2]}:${coords[coords.length - 3]}`;
  if (key === bestKey || !bests.length) return;
  bestKey = key;
  bests[bestIdx].fade(0, reduceMotion ? 0 : 500);
  bestIdx = 1 - bestIdx;
  revealLine(bests[bestIdx], interleavedToLngLat(coords), 700);
}
/** Efface les traces de la recherche (fondu de ms millisecondes). */
function clearSearch(ms = 0) {
  searchToken++;
  queue.length = 0; clearInterval(pump); pump = 0; alive = 0; bestKey = '';
  for (const g of [...ghosts, ...bests]) g.fade(0, reduceMotion ? 0 : ms);
  const token = searchToken;
  setTimeout(() => {
    if (token !== searchToken) return;
    for (const g of [...ghosts, ...bests]) { g.clear(); g.busy = false; g.shown = false; }
  }, (reduceMotion ? 0 : ms) + 50);
}
function clearRoute() {
  animToken++; altToken++;
  route?.clear();
  for (const a of alts) a.clear();
  for (const f of flags) f.remove();
  flags = [];
  cursor.remove();
}

let liveBest = 0;
function setLive(evals, best) {
  $('liveEvals').textContent = fmtInt(evals);
  if (best != null && Math.round(best) > liveBest) { liveBest = Math.round(best); $('liveBest').textContent = `+${fmtInt(best)}`; }
}

// --- Génération ---------------------------------------------------------------------------------
let results = [];
let current = 0;
let goal = null; // objectif dénivelé de la dernière génération
const BUDGET = 3600;

let genToken = 0;
async function generate() {
  if (!start) return hint('Choisis d’abord un départ : adresse, position, ou touche la carte.', true);
  const tol = parseFloat(val('tol'));
  // Objectif dénivelé : la distance devient libre (bornée par la zone chargée).
  const upGoal = goalIsUp() ? parseFloat($('up').value) : 0;
  const d = parseFloat($('dist').value);
  const dmin = upGoal ? 1 : d * (1 - tol), dmax = upGoal ? upMaxKm() : d * (1 + tol);
  const mode = val('mode');
  savePrefs();
  hint('');
  setState('search');
  $('searchTitle').textContent = 'Chargement du terrain';
  $('searchPct').textContent = '';
  step('search', '', '');
  liveBest = 0; setLive(0, null); $('liveBest').textContent = '—'; $('bar').style.width = '0';
  const my = ++genToken;
  const cancelled = () => my !== genToken;
  watchWait(my);
  await mapOrTimeout();
  if (cancelled()) return;
  clearRoute(); clearSearch();
  // On part serré sur le départ…
  flyToVisible(llOf(...start), 15, 700);

  try {
    const radius = areaRadius();
    if (covers(area, start, radius) && !reduceMotion && fx) {
      // Terrain déjà prêt (préchargé) : la séquence de chargement est rejouée en accéléré.
      step('osm', 'on'); step('dem', 'on'); step('graph', '');
      await wait(450);
      const replay = fx.replay(area.center, area.radius);
      setTimeout(() => step('osm', 'done', 'en cache'), 900);
      await replay;
    }
    await ensureArea(start, radius);
    if (cancelled()) return;
    fx?.clear();
    $('searchTitle').textContent = 'Recherche du meilleur parcours';
    step('search', 'on');
    // … puis on dézoome progressivement pendant la recherche.
    const reach = Math.min(dmax * 1000 * 0.32, 8000);
    const dezoom = (ms) => {
      if (!reduceMotion) map.fitBounds(boundsAround(start, reach), { padding: mapPadding(), linear: true, duration: ms, easing: (t) => t });
    };
    dezoom(BUDGET + 600);
    let explored = [];
    const params = {
      startLatLon: start, mode, dmin: dmin * 1000, dmax: dmax * 1000, reps: mode === 'repeat' ? reps : 0,
      surface: val('surface'), avoidStairs: $('stairs').checked,
      avoidReuse: $('optReuse').checked, avoidSameStreet: $('optStreet').checked, hillCap: parseInt(val('cap'), 10),
      ...(upGoal ? { upTarget: upGoal, upTol: tol } : {}),
      budgetMs: BUDGET, seed: (Math.random() * 2 ** 31) | 0,
    };
    const res = await call({ type: 'solve', params }, (p) => {
      if (cancelled()) return;
      if (p.phase === 'search') {
        for (const c of p.candidates || []) enqueue(c.coords);
        if (p.best) showBest(p.best.coords);
        setLive(p.evals, p.best?.up);
        const pct = Math.round((p.progress || 0) * 100);
        $('bar').style.width = `${pct}%`;
        $('searchPct').textContent = `${pct} %`;
      } else if (p.phase === 'climbs-explored') explored = p.candidates;
    }, BUDGET + 30000, 'La recherche ne répond plus. Réessaie.');
    if (cancelled()) return;
    // Mode « côte » : la recherche est instantanée, on rejoue les côtes examinées.
    if (explored.length && !reduceMotion) {
      const D = 1800, k = explored.length;
      dezoom(D);
      for (let i = 0; i < k; i++) {
        enqueue(explored[i].coords);
        setLive(i + 1, explored[i].up);
        $('bar').style.width = `${((i + 1) / k) * 100}%`;
        await wait(D / k);
      }
    }
    await drainQueue(1200);
    goal = upGoal ? { up: upGoal, lo: upGoal * (1 - tol), hi: upGoal * (1 + tol) } : null;
    const inGoal = (r) => (r.up >= goal.lo && r.up <= goal.hi ? 0 : 1);
    // Objectif dénivelé : d'abord ceux qui sont dans la marge, puis le plus court.
    results = res.result.routes.sort(goal ? (a, b) => inGoal(a) - inGoal(b) || a.distance - b.distance : (a, b) => b.up - a.up);
    if (!results.length) throw new Error('Aucun parcours trouvé ici. Essaie une autre distance, une autre surface ou un autre départ.');
    step('search', 'done', `${(res.result.timeMs / 1000).toFixed(1)} s`);
    $('bar').style.width = '100%';
    $('searchTitle').textContent = results.length > 1 ? `${results.length} parcours retenus` : 'Parcours retenu';
    await eliminate(results);
    if (cancelled()) return;
    clearSearch(0);
    setState('result');
    renderVariants();
    await show(0, true);
  } catch (e) {
    if (cancelled()) return;
    console.error(e);
    diag.log(`erreur : ${e.message}`);
    clearSearch();
    fx?.clear();
    setState('setup');
    hint(e.message, true);
  } finally {
    if (!cancelled()) watchWait(0);
  }
}

// --- Suivi de l'attente : ce que l'on attend, depuis combien de temps, et « Annuler » ------------
const WAIT_NOTE = {
  osm: (s) => s > 40 ? 'Les serveurs OpenStreetMap sont lents : on essaie les serveurs de secours.' : 'Téléchargement du réseau OpenStreetMap…',
  dem: () => 'Téléchargement des altitudes…',
  graph: () => 'Préparation du réseau pour la recherche…',
  search: () => 'Recherche en cours…',
};
let waitTimer = 0;
function watchWait(token) {
  clearInterval(waitTimer);
  $('waitNote').hidden = true;
  if (!token) return;
  waitTimer = setInterval(() => {
    if (token !== genToken || state !== 'search') { clearInterval(waitTimer); return; }
    const now = performance.now();
    const [name, t0] = Object.entries(stepT).sort((a, b) => a[1] - b[1])[0] || [];
    const secs = t0 ? Math.round((now - t0) / 1000) : 0;
    $('waitNote').hidden = !name || secs < 6;
    if (name && secs >= 6) $('waitNote').textContent = `${WAIT_NOTE[name](secs)} ${secs} s`;
  }, 500);
}
$('cancel').onclick = () => {
  genToken++;
  watchWait(0);
  clearSearch(); fx?.clear(); clearRoute();
  for (const k of Object.keys(stepT)) delete stepT[k];
  setState('setup');
  hint('Génération annulée. Le terrain continue de se charger en arrière-plan.');
  diag.log('génération annulée');
};

$('go').onclick = () => generate();
$('again').onclick = () => generate();
$('edit').onclick = () => { setState('setup'); hint(''); clearRoute(); };

// --- Résultats ----------------------------------------------------------------------------------
function renderVariants() {
  const box = $('variants');
  box.innerHTML = '';
  results.forEach((r, i) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.innerHTML = `<span class="k">${String.fromCharCode(65 + i)}</span>+${fmtInt(r.up)} m`;
    b.setAttribute('aria-label', `Variante ${String.fromCharCode(65 + i)}, ${fmtInt(r.up)} mètres de D+, ${fmtKm(r.distance)} km`);
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
  // Côtes de la séance : une ligne par côte (montées, longueur, pente, gain).
  const pct = (g) => `${(g * 100).toFixed(1).replace('.', ',')} %`;
  const row = (c) => `<li><b>×${c.reps}</b><span>${fmtInt(c.length)} m à ${pct(c.grade)}</span><span class="g">+${fmtInt(c.gain)} m</span></li>`;
  if (r.kind === 'repeat') {
    climb.innerHTML = row(r.climb) + `<li class="sub"><span>Accès depuis le départ : ${fmtKm(r.climb.approach)} km, aller et retour</span></li>`;
  } else if (r.kind === 'circuit') {
    climb.innerHTML = r.circuit.map(row).join('');
  } else climb.hidden = true;

  // Objectif dénivelé hors d'atteinte : on le dit, sans détour.
  const gn = $('rGoal');
  gn.hidden = !goal || (r.up >= goal.lo && r.up <= goal.hi);
  if (!gn.hidden) {
    gn.textContent = r.up < goal.lo
      ? `Objectif +${fmtInt(goal.up)} m non atteint autour de ce départ (au plus ${fmtInt(upMaxKm())} km explorés). Essaie une marge plus large ou un autre départ.`
      : `Un peu plus que l’objectif +${fmtInt(goal.up)} m : pas de parcours plus juste ici.`;
  }

  const facts = [
    ['D−', `${fmtInt(r.down)} m`],
    ['Altitude', `${fmtInt(r.minEle)}–${fmtInt(r.maxEle)} m`],
    ['D+ / km', `${fmtInt(r.up / (r.distance / 1000))} m`],
    r.kind === 'repeat' ? ['Répétitions', `${r.climb.reps}`] : ['Montées', `${r.bigClimbs}`],
  ];
  $('rFacts').innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  let note = `Réseau OpenStreetMap, altitude ${demSource}.`;
  if (r.kind === 'loop' && r.overlap > 0.05) note = `${Math.round(r.overlap * 100)} % du tracé est emprunté deux fois. ` + note;
  $('source').textContent = note;

  // Les autres variantes restent en fin sur la carte, sous le parcours choisi.
  alts.forEach((line, k) => line.fade(k === i || k >= results.length ? 0 : ALT_OPACITY, reduceMotion ? 0 : 400));
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
  if (!route) { profileGeom = drawProfile($('profile'), r); return; } // carte pas encore prête
  route.clear();
  for (const f of flags) f.remove();
  flags = [];
  const coords = Array.from(r.lat, (la, k) => [r.lon[k], la]);
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(bounds, { padding: mapPadding(), duration: animate ? 700 : 0, maxZoom: 17 });
  const tops = r.kind === 'repeat' ? [{ top: r.climb.top, label: `×${r.climb.reps}` }]
    : r.kind === 'circuit' ? r.circuit.map((c) => ({ top: c.top, label: `×${c.reps}` })) : [];
  const D = animate ? 1500 : 0;
  await route.set(coords);
  if (animate) await wait(700);
  if (token !== animToken) return;
  // Tracé et profil se dessinent ensemble
  await tween(D, (k) => {
    route.show(k);
    profileGeom = drawProfile($('profile'), r, { reveal: k });
  }, { ease: easeOut2, alive: () => token === animToken });
  if (token !== animToken) return;
  for (const t of tops) {
    const el = document.createElement('div');
    el.className = 'flag';
    el.innerHTML = `<span class="pin-flag">${t.label}</span>`;
    flags.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(llOf(t.top[0], t.top[1])).addTo(map));
  }
}

// Curseur synchronisé profil ↔ carte
function hoverAt(clientX) {
  const r = results[current];
  if (!r || !profileGeom) return;
  const rect = $('profile').getBoundingClientRect();
  const i = indexAt(r, clientX - rect.left, profileGeom);
  profileGeom = drawProfile($('profile'), r, { hoverIdx: i });
  cursor.setLngLat([r.lon[i], r.lat[i]]).addTo(map);
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
