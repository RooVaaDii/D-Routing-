// Carte : MapLibre GL JS (copié dans vendor/) + tuiles vectorielles OpenFreeMap.
// Style maison très épuré ; ses couleurs viennent des variables CSS de l'appli.
import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';

export { maplibregl };

const OFM = 'https://tiles.openfreemap.org';
export const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** Lit les jetons de couleur définis dans style.css (:root). */
export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: v('--ink', '#111214'),
    sub: v('--sub', '#71737A'),
    accent: v('--accent', '#FF4D17'),
    bg: v('--bg', '#FFFFFF'),
    land: v('--map-land', '#F6F6F4'),
    water: v('--map-water', '#DCE3E9'),
    park: v('--map-park', '#E7ECE3'),
    building: v('--map-building', '#ECECE8'),
    road: v('--map-road', '#DEDFE1'),
    roadMajor: v('--map-road-major', '#CFD0D3'),
    path: v('--map-path', '#CDCED2'),
    rail: v('--map-rail', '#E2E2E4'),
    label: v('--map-label', '#6B6D74'),
    place: v('--map-place', '#3B3C40'),
  };
}

const lines = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const polys = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const cls = (...c) => ['match', ['get', 'class'], c, true, false];
const notTunnel = ['!=', ['get', 'brunnel'], 'tunnel'];
const zw = (...stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];
const name = ['coalesce', ['get', 'name:fr'], ['get', 'name'], ['get', 'name:latin']];

/** Teinte d'altitude : transparente en bas, encre légère en haut (une seule couleur). */
export function topoRamp(t, lo, hi) {
  const span = Math.max(hi - lo, 10);
  return ['interpolate', ['linear'], ['elevation'],
    lo, rgba(t.ink, 0), lo + span * 0.5, rgba(t.ink, 0.12), hi, rgba(t.ink, 0.3)];
}

/** Style vectoriel maison : fond clair, rues grises, eau et parcs discrets. */
export function baseStyle(t = tokens()) {
  const v = (id, layer) => ({ id, source: 'ofm', ...layer });
  return {
    version: 8,
    name: 'D+ Routing',
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      ofm: { type: 'vector', url: `${OFM}/planet` },
      // Relief (animation du chargement des altitudes) : mêmes tuiles Terrarium que le moteur.
      relief: {
        type: 'raster-dem', encoding: 'terrarium', tiles: [TERRARIUM], tileSize: 256, maxzoom: 15,
        attribution: '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a>',
      },
      'fx-veil': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    transition: { duration: 0, delay: 0 },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': t.land } },
      // Relief, révélé pendant le chargement des altitudes (invisible sinon). Sous les parcs et l'eau.
      { id: 'relief', type: 'hillshade', source: 'relief', layout: { visibility: 'none' },
        paint: {
          'hillshade-exaggeration': 0, 'hillshade-shadow-color': t.ink, 'hillshade-accent-color': t.ink,
          'hillshade-highlight-color': t.bg,
        } },
      { id: 'topo', type: 'color-relief', source: 'relief', layout: { visibility: 'none' },
        paint: { 'color-relief-opacity': 0, 'color-relief-color': topoRamp(t, 0, 200) } },
      // Voile couleur du fond, percé d'un disque qui grandit depuis le départ.
      { id: 'fx-veil', type: 'fill', source: 'fx-veil', layout: { visibility: 'none' },
        paint: { 'fill-color': t.land, 'fill-antialias': false } },
      // Bord du disque : visible même en terrain plat, il montre la progression des altitudes.
      { id: 'fx-edge', type: 'line', source: 'fx-veil', layout: { visibility: 'none' },
        paint: { 'line-color': t.ink, 'line-width': 1.5, 'line-opacity': 0.45 } },
      v('park', { type: 'fill', 'source-layer': 'park', filter: polys, paint: { 'fill-color': t.park } }),
      v('wood', { type: 'fill', 'source-layer': 'landcover', filter: ['all', polys, cls('wood', 'grass')],
        paint: { 'fill-color': t.park, 'fill-opacity': 0.7 } }),
      v('water', { type: 'fill', 'source-layer': 'water', filter: ['all', polys, notTunnel], paint: { 'fill-color': t.water } }),
      v('waterway', { type: 'line', 'source-layer': 'waterway', filter: ['all', lines, notTunnel],
        paint: { 'line-color': t.water, 'line-width': zw(10, 0.5, 18, 4) } }),
      v('building', { type: 'fill', 'source-layer': 'building', minzoom: 14,
        paint: { 'fill-color': t.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, 1] } }),

      v('rail', { type: 'line', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', lines, cls('rail', 'transit'), notTunnel],
        paint: { 'line-color': t.rail, 'line-width': zw(12, 0.6, 18, 2) } }),
      v('path', { type: 'line', 'source-layer': 'transportation', minzoom: 13,
        filter: ['all', lines, cls('path', 'track'), notTunnel],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: { 'line-color': t.path, 'line-width': zw(13, 0.7, 18, 2.2), 'line-dasharray': ['literal', [2.2, 1.4]] } }),
      v('road-minor', { type: 'line', 'source-layer': 'transportation', minzoom: 11,
        filter: ['all', lines, cls('minor', 'service', 'pedestrian', 'raceway', 'busway'), notTunnel],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': t.road, 'line-width': zw(12, 0.5, 14, 1.6, 16, 4, 18, 12) } }),
      v('road-major', { type: 'line', 'source-layer': 'transportation', minzoom: 8,
        filter: ['all', lines, cls('motorway', 'trunk', 'primary', 'secondary', 'tertiary'), notTunnel],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': t.roadMajor, 'line-width': zw(9, 0.6, 12, 1.4, 14, 3, 16, 6, 18, 16) } }),

      v('label-water', { type: 'symbol', 'source-layer': 'water_name', minzoom: 12,
        layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 12, 'text-max-width': 8 },
        paint: { 'text-color': t.label, 'text-opacity': 0.8, 'text-halo-color': t.land, 'text-halo-width': 1.2 } }),
      v('label-street', { type: 'symbol', 'source-layer': 'transportation_name', minzoom: 14,
        filter: ['all', lines, ['!', cls('motorway', 'trunk', 'rail', 'transit')]],
        layout: {
          'symbol-placement': 'line', 'text-field': name, 'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 17, 13.5], 'text-max-angle': 30, 'symbol-spacing': 320,
        },
        paint: { 'text-color': t.label, 'text-halo-color': t.land, 'text-halo-width': 1.6 } }),
      v('label-peak', { type: 'symbol', 'source-layer': 'mountain_peak', minzoom: 12,
        filter: ['has', 'name'],
        layout: {
          'text-field': ['case', ['has', 'ele'], ['concat', ['get', 'name'], '\n', ['to-string', ['get', 'ele']], ' m'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-max-width': 8,
        },
        paint: { 'text-color': t.label, 'text-halo-color': t.land, 'text-halo-width': 1.4 } }),
      v('label-quarter', { type: 'symbol', 'source-layer': 'place', minzoom: 12,
        filter: cls('suburb', 'quarter', 'neighbourhood', 'hamlet', 'village'),
        layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 13], 'text-max-width': 7 },
        paint: { 'text-color': t.place, 'text-opacity': 0.75, 'text-halo-color': t.land, 'text-halo-width': 1.4 } }),
      v('label-town', { type: 'symbol', 'source-layer': 'place', maxzoom: 14,
        filter: cls('city', 'town'),
        layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 15], 'text-max-width': 8 },
        paint: { 'text-color': t.place, 'text-halo-color': t.land, 'text-halo-width': 1.4 } }),
    ],
  };
}

const isPhone = () => innerWidth <= 720;

/** Crée la carte, ses contrôles et l'attribution (toujours visible). */
export function createMap(container, { center, zoom }) {
  const map = new maplibregl.Map({
    container, style: baseStyle(), center, zoom,
    attributionControl: false,
    dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
    renderWorldCopies: false, fadeDuration: 180, maxZoom: 19,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  // Sur mobile la feuille couvre le bas : attribution en haut à gauche.
  map.addControl(new maplibregl.AttributionControl({
    compact: isPhone(),
  }), isPhone() ? 'top-left' : 'bottom-right');
  // Compacte : repliée d'emblée (MapLibre l'ouvre au démarrage), un toucher sur « i » l'affiche.
  if (isPhone()) map.once('load', () => map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  if (!isPhone()) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  return map;
}

// --- Lignes animées (révélation progressive sur le GPU) -----------------------------------

export function rgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Dégradé le long de la ligne : couleur pleine jusqu'à k, transparent après. */
function reveal(color, k) {
  const on = rgba(color, 1), off = rgba(color, 0);
  if (k >= 0.999) return ['interpolate', ['linear'], ['line-progress'], 0, on, 1, on];
  if (k <= 0.001) return ['interpolate', ['linear'], ['line-progress'], 0, off, 1, off];
  return ['interpolate', ['linear'], ['line-progress'], 0, on, k, on, Math.min(1, k + 0.004), off];
}

const QUIET = { validate: false };
const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * Une ligne GeoJSON (avec liseré éventuel) dont on dévoile progressivement le tracé :
 * on ne touche qu'au dégradé `line-gradient` (line-progress), la géométrie reste sur le GPU.
 */
export class RevealLine {
  constructor(map, id, { color, width, opacity = 1, casing = null, before } = {}) {
    this.map = map; this.id = id; this.opacity = opacity;
    this.k = -1;
    map.addSource(id, { type: 'geojson', lineMetrics: true, data: EMPTY });
    const layout = { 'line-cap': 'round', 'line-join': 'round' };
    this.layers = [];
    if (casing) {
      map.addLayer({ id: `${id}-casing`, type: 'line', source: id, layout,
        paint: { 'line-width': casing.width, 'line-opacity': opacity, 'line-gradient': reveal(casing.color, 0) } }, before);
      this.layers.push([`${id}-casing`, casing.color]);
    }
    map.addLayer({ id, type: 'line', source: id, layout,
      paint: { 'line-width': width, 'line-opacity': opacity, 'line-gradient': reveal(color, 0) } }, before);
    this.layers.push([id, color]);
  }

  /** coords : [[lon, lat], …] ; la promesse est tenue quand la géométrie est prête. */
  set(coords) {
    this.show(0);
    this.fade(this.opacity, 0);
    return this.map.getSource(this.id).setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  }

  clear() {
    this.show(0);
    return this.map.getSource(this.id).setData(EMPTY);
  }

  /** Part dévoilée du tracé (0 → 1). */
  show(k) {
    if (Math.abs(k - this.k) < 0.0005) return;
    this.k = k;
    for (const [lid, c] of this.layers) this.map.setPaintProperty(lid, 'line-gradient', reveal(c, k), QUIET);
  }

  /** Opacité, en fondu de ms millisecondes (transition gérée par MapLibre). */
  fade(opacity, ms, delay = 0) {
    for (const [lid] of this.layers) {
      this.map.setPaintProperty(lid, 'line-opacity-transition', { duration: ms, delay }, QUIET);
      this.map.setPaintProperty(lid, 'line-opacity', opacity, QUIET);
    }
  }
}

/** Convertit [lat, lon, lat, lon, …] (format du worker) en [[lon, lat], …]. */
export function interleavedToLngLat(c) {
  const out = new Array(c.length / 2);
  for (let i = 0, j = 0; i < c.length; i += 2, j++) out[j] = [c[i + 1], c[i]];
  return out;
}

/** Tween sur requestAnimationFrame ; `alive()` permet d'interrompre. */
export function tween(ms, onFrame, { ease = (t) => t, alive = () => true } = {}) {
  return new Promise((resolve) => {
    if (ms <= 0) { onFrame(1); return resolve(true); }
    const t0 = performance.now();
    const frame = (now) => {
      if (!alive()) return resolve(false);
      const k = Math.min(1, (now - t0) / ms);
      onFrame(ease(k));
      if (k < 1) requestAnimationFrame(frame); else resolve(true);
    };
    requestAnimationFrame(frame);
  });
}

// --- Animation du chargement du terrain -------------------------------------------------------

const RINGS = 10;          // anneaux du réseau autour du départ (serrés près de lui)
const CELL = 55;           // taille d'une tuile de la grille de téléchargement (m)
const CELLS_MAX = 12000;   // nombre de tuiles au plus (les grandes zones ont des tuiles un peu plus grandes)
const WAVES = 24;          // couches de la vague (une par couronne, vitesse constante)
const WAVE_MS = 1600;      // période de la vague
const WAVE_STEP = 45;      // décalage entre deux couronnes (ms) : la vague traverse en ~1 s
const ringOf = (d, radius) => Math.min(RINGS - 1, Math.floor(Math.sqrt(Math.max(0, d) / radius) * RINGS));

/** Mètres → degrés autour d'une latitude. */
const mPerDeg = (lat) => [111320 * Math.cos(lat * Math.PI / 180), 111320];

/** Grille de petites tuiles carrées autour du départ, rangées par couronne (pour la vague). */
function cellGrid([lat, lon], radius) {
  const [kx, ky] = mPerDeg(lat);
  // La grille couvre toute la zone chargée, comme le disque du relief.
  const R = radius;
  const cell = Math.max(CELL, R * Math.sqrt(Math.PI / CELLS_MAX));
  const n = Math.ceil(R / cell), features = [];
  for (let i = -n; i < n; i++) {
    for (let j = -n; j < n; j++) {
      const cx = (i + 0.5) * cell, cy = (j + 0.5) * cell, d = Math.hypot(cx, cy);
      if (d > R) continue;
      const g = 1.2; // joint (m de chaque côté) : environ 1 pixel au zoom du chargement
      const x0 = lon + (i * cell + g) / kx, x1 = lon + ((i + 1) * cell - g) / kx;
      const y0 = lat + (j * cell + g) / ky, y1 = lat + ((j + 1) * cell - g) / ky;
      features.push({ type: 'Feature', properties: { w: Math.min(WAVES - 1, Math.floor((d / R) * WAVES)) },
        geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Voile percé d'un disque de rayon r (m) centré sur le départ. */
function veil([lat, lon], r, outer) {
  const [kx, ky] = mPerDeg(lat);
  const box = [[lon - outer / kx, lat - outer / ky], [lon + outer / kx, lat - outer / ky],
    [lon + outer / kx, lat + outer / ky], [lon - outer / kx, lat + outer / ky], [lon - outer / kx, lat - outer / ky]];
  const hole = [];
  for (let k = 64; k >= 0; k--) {
    const a = (k / 64) * 2 * Math.PI;
    hole.push([lon + (r * Math.cos(a)) / kx, lat + (r * Math.sin(a)) / ky]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: r > 1 ? [box, hole] : [box] } };
}

/**
 * Montre sur la carte les deux premières étapes du chargement :
 * - « Réseau OpenStreetMap » : une grille de tuiles autour du départ se balaie en vagues tant que
 *   les données arrivent, puis le réseau la remplace, anneau par anneau, depuis le départ ;
 * - « Altitudes » : un disque grandit depuis le départ avec la progression et dévoile le relief
 *   (ombrage + teinte d'altitude).
 * Les fondus passent par les transitions de style de MapLibre (GPU) ; seul le voile est recalculé.
 */
export class TerrainFx {
  constructor(map, t, { reduceMotion = false, before } = {}) {
    this.map = map; this.t = t; this.rm = reduceMotion;
    this.worker = null; this.job = 0; this.timers = [];
    this.cache = null; // { key, net, range } : pour rejouer quand le terrain est déjà prêt
    map.addSource('fx-cells', { type: 'geojson', data: EMPTY });
    map.addSource('fx-net', { type: 'geojson', data: EMPTY });
    for (let i = 0; i < WAVES; i++) {
      map.addLayer({ id: `fx-cell-${i}`, type: 'fill', source: 'fx-cells', filter: ['==', ['get', 'w'], i],
        paint: { 'fill-color': t.ink, 'fill-opacity': 0 } }, before);
    }
    for (let i = 0; i < RINGS; i++) {
      map.addLayer({ id: `fx-net-${i}`, type: 'line', source: 'fx-net', filter: ['==', ['get', 'r'], i],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': t.ink, 'line-opacity': 0, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 1.6] } }, before);
    }
  }

  _paint(id, prop, value, ms = 0, delay = 0) {
    this.map.setPaintProperty(id, `${prop}-transition`, { duration: this.rm ? 0 : ms, delay: this.rm ? 0 : delay }, QUIET);
    this.map.setPaintProperty(id, prop, value, QUIET);
  }
  _later(fn, ms) { const job = this.job; this.timers.push(setTimeout(() => job === this.job && fn(), ms)); }
  _stopTimers() { for (const t of this.timers) clearTimeout(t); this.timers = []; clearInterval(this.sweepTimer); cancelAnimationFrame(this.raf); }
  _show(id, on) { if (this.map.getLayoutProperty(id, 'visibility') !== (on ? 'visible' : 'none')) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); }

  /** Début du chargement d'une zone (centre [lat, lon], rayon en m). */
  begin(center, radius) {
    this._stopTimers();
    this.job++;
    this.center = center; this.radius = radius; this.t0 = performance.now();
    this.key = `${center[0].toFixed(5)},${center[1].toFixed(5)},${Math.round(radius)}`;
    this.netReady = false;
    this.map.getSource('fx-net').setData(EMPTY);
    for (let i = 0; i < RINGS; i++) this._paint(`fx-net-${i}`, 'line-opacity', 0);
    for (let i = 0; i < WAVES; i++) this._paint(`fx-cell-${i}`, 'fill-opacity', 0);
    this.map.getSource('fx-cells').setData(cellGrid(center, radius)).then(() => this._sweep());
    // Relief : tout est voilé, le disque grandira avec la progression.
    this.veilR = 0; this.veilTarget = 0;
    this.map.getSource('fx-veil').setData(veil(center, 0, radius * 3));
    this._show('fx-veil', true); this._show('fx-edge', true); this._show('relief', true); this._show('topo', true);
    this._paint('relief', 'hillshade-exaggeration', 0.55, 0);
    this._paint('topo', 'color-relief-opacity', 0, 0);
  }

  /**
   * Vague continue sur la grille, du départ vers l'extérieur, tant que le réseau n'est pas là :
   * chaque couronne monte puis redescend, décalée de la précédente (transitions MapLibre).
   */
  _sweep() {
    const wave = () => {
      if (this.netReady) return;
      for (let i = 0; i < WAVES; i++) {
        const d = i * WAVE_STEP;
        this._later(() => this._paint(`fx-cell-${i}`, 'fill-opacity', 0.15, 380), d);
        this._later(() => this._paint(`fx-cell-${i}`, 'fill-opacity', 0.035, 900), d + 400);
      }
    };
    wave();
    if (this.rm) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = setInterval(wave, WAVE_MS);
  }

  /** Réseau prêt (GeoJSON en anneaux) : il remplace la grille, vague par vague. */
  _revealNetwork(net) {
    // Au moins une vague complète de la grille, même si les données étaient en cache.
    const wait = Math.max(0, WAVE_MS - (performance.now() - this.t0));
    this._later(() => {
      this.netReady = true;
      clearInterval(this.sweepTimer);
      this.map.getSource('fx-net').setData(net).then(() => {
        for (let i = 0; i < WAVES; i++) this._paint(`fx-cell-${i}`, 'fill-opacity', 0, 450, i * WAVE_STEP);
        for (let i = 0; i < RINGS; i++) this._paint(`fx-net-${i}`, 'line-opacity', 0.6, 420, i * 80);
      });
    }, this.rm ? 0 : wait);
  }

  /** Réseau OSM reçu (texte JSON Overpass) : découpe en anneaux dans un petit worker. */
  network(osmText) {
    const job = this.job, key = this.key;
    if (!this.worker) this.worker = new Worker(new URL('./netrings.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      this.cache = { ...(this.cache?.key === key ? this.cache : {}), key, net: ev.data };
      if (job === this.job) this._revealNetwork(ev.data);
    };
    this.worker.postMessage({ osmText, center: this.center, radius: this.radius, rings: RINGS });
  }

  /** Progression des altitudes (0 → 1) : le disque de relief s'agrandit. */
  setRelief(f) {
    // Croissance quadratique : le bord du disque traverse d'abord la partie visible (près du départ).
    this.veilTarget = Math.max(this.veilTarget, f * f * this.radius);
    if (this.rm) { this._setVeil(this.veilTarget); return; }
    if (this.raf) return;
    const step = () => {
      const d = this.veilTarget - this.veilR;
      this._setVeil(Math.abs(d) < this.radius * 0.002 ? this.veilTarget : this.veilR + d * 0.1);
      this.raf = this.veilR < this.veilTarget ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }
  _setVeil(r) {
    this.veilR = r;
    this.map.getSource('fx-veil').setData(veil(this.center, r, this.radius * 3));
  }

  /** Plage d'altitude de la zone (m) : la teinte d'altitude apparaît. */
  setRange(lo, hi) {
    if (this.cache?.key === this.key) this.cache.range = [lo, hi]; else this.cache = { key: this.key, range: [lo, hi] };
    this.map.setPaintProperty('topo', 'color-relief-color', topoRamp(this.t, lo, hi), QUIET);
    this._paint('topo', 'color-relief-opacity', 1, 700);
  }

  /** Terrain déjà chargé : rejoue la séquence en accéléré. Résout quand elle est jouée. */
  async replay(center, radius) {
    const c = this.cache;
    this.begin(center, radius);
    if (c?.key !== this.key || !c.net) { this.setRelief(1); return; }
    this._revealNetwork(c.net);
    if (c.range) this._later(() => this.setRange(...c.range), 500);
    if (this.rm) { this.setRelief(1); return; }
    await tween(1300, (k) => this.setRelief(k), { ease: (t) => 1 - Math.pow(1 - t, 2) });
    await new Promise((r) => setTimeout(r, 450));
  }

  /** Efface toute l'animation (fondu), après un éventuel délai. */
  clear(delay = 0) {
    this._stopTimers();
    const job = ++this.job;
    this.raf = 0;
    this._show('fx-veil', false); this._show('fx-edge', false);
    for (let i = 0; i < RINGS; i++) this._paint(`fx-net-${i}`, 'line-opacity', 0, 600, delay);
    for (let i = 0; i < WAVES; i++) this._paint(`fx-cell-${i}`, 'fill-opacity', 0, 400, delay);
    this._paint('relief', 'hillshade-exaggeration', 0, 700, delay);
    this._paint('topo', 'color-relief-opacity', 0, 700, delay);
    setTimeout(() => {
      if (job !== this.job) return;
      this.map.getSource('fx-net').setData(EMPTY);
      this.map.getSource('fx-cells').setData(EMPTY);
      this._show('relief', false); this._show('topo', false);
    }, (this.rm ? 0 : delay + 800));
  }
}
