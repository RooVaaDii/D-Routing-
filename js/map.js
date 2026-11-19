// Carte : MapLibre GL JS (copié dans vendor/) + tuiles vectorielles OpenFreeMap.
// Style maison très épuré ; ses couleurs viennent des variables CSS de l'appli.
import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';

export { maplibregl };

const OFM = 'https://tiles.openfreemap.org';

/** Lit les jetons de couleur définis dans style.css (:root). */
export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: v('--ink', '#111214'),
    sub: v('--sub', '#71737A'),
    accent: v('--accent', '#FF4D17'),
    bg: v('--bg', '#FFFFFF'),
    land: v('--map-land', '#F5F5F3'),
    water: v('--map-water', '#DEE4E9'),
    park: v('--map-park', '#E9EDE5'),
    building: v('--map-building', '#ECECE9'),
    road: v('--map-road', '#DCDDDF'),
    roadMajor: v('--map-road-major', '#CDCED1'),
    path: v('--map-path', '#CFD0D3'),
    rail: v('--map-rail', '#E1E1E3'),
    label: v('--map-label', '#6B6D74'),
    place: v('--map-place', '#3B3C40'),
  };
}

const lines = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const polys = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const cls = (...c) => ['match', ['get', 'class'], c, true, false];
const notTunnel = ['!=', ['get', 'brunnel'], 'tunnel'];
const zw = (...stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops];
const name = ['coalesce', ['get', 'name'], ['get', 'name:latin']];

/** Style vectoriel maison : fond clair, rues grises, eau et parcs discrets. */
export function baseStyle(t = tokens()) {
  const v = (id, layer) => ({ id, source: 'ofm', ...layer });
  return {
    version: 8,
    name: 'D+ Routing',
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    sources: { ofm: { type: 'vector', url: `${OFM}/planet` } },
    transition: { duration: 0, delay: 0 },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': t.land } },
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
    attributionControl: false, maplibreLogo: false,
    dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
    renderWorldCopies: false, fadeDuration: 180, maxZoom: 19,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  // Sur mobile la feuille couvre le bas : attribution en haut à gauche.
  map.addControl(new maplibregl.AttributionControl({ compact: isPhone() }), isPhone() ? 'top-left' : 'bottom-right');
  if (!isPhone()) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  return map;
}

// --- Lignes animées (révélation progressive sur le GPU) -----------------------------------

const rgba = (hex, a) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** Dégradé le long de la ligne : couleur pleine jusqu'à k, transparent après. */
function reveal(color, k) {
  const on = rgba(color, 1), off = rgba(color, 0);
  if (k >= 0.999) return ['interpolate', ['linear'], ['line-progress'], 0, on, 1, on];
  if (k <= 0.001) return ['interpolate', ['linear'], ['line-progress'], 0, off, 1, off];
  return ['interpolate', ['linear'], ['line-progress'], 0, on, k, on, Math.min(1, k + 0.003), off];
}

const QUIET = { validate: false };

/**
 * Une ligne GeoJSON (avec liseré éventuel) dont on dévoile progressivement le tracé :
 * on ne touche qu'au dégradé `line-gradient` (line-progress), la géométrie reste sur le GPU.
 */
export class RevealLine {
  constructor(map, id, { color, width, opacity = 1, casing = null, before } = {}) {
    this.map = map; this.id = id; this.color = color; this.casingColor = casing?.color;
    this.opacity = opacity;
    this.k = -1;
    map.addSource(id, { type: 'geojson', lineMetrics: true, data: { type: 'FeatureCollection', features: [] } });
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

  /** coords : [[lon, lat], …] */
  set(coords) {
    this.show(0);
    this.fade(this.opacity, 0);
    return this.map.getSource(this.id).setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  }

  clear() {
    this.show(0);
    return this.map.getSource(this.id).setData({ type: 'FeatureCollection', features: [] });
  }

  /** Part dévoilée du tracé (0 → 1). */
  show(k) {
    if (Math.abs(k - this.k) < 0.0005) return;
    this.k = k;
    for (const [lid, c] of this.layers) this.map.setPaintProperty(lid, 'line-gradient', reveal(c, k), QUIET);
  }

  /** Opacité, en fondu de ms millisecondes (transition gérée par MapLibre). */
  fade(opacity, ms) {
    for (const [lid] of this.layers) {
      this.map.setPaintProperty(lid, 'line-opacity-transition', { duration: ms, delay: 0 }, QUIET);
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
