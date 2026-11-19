// Modèle numérique de terrain à partir des tuiles libres « Terrarium »
// (Mapzen / AWS Open Data, données SRTM, EU-DEM, etc.).
// Le décodage PNG est injecté : canvas dans le navigateur, pngjs dans les tests Node.

import { lonToTileX, latToTileY } from './geo.js';

export const TERRARIUM_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const TILE = 256;

/** Choisit le zoom le plus fin possible sans dépasser maxTiles tuiles. */
export function planTiles(bbox, maxTiles = 64) {
  for (let z = 14; z >= 9; z--) {
    const x0 = Math.floor(lonToTileX(bbox.w, z));
    const x1 = Math.floor(lonToTileX(bbox.e, z));
    const y0 = Math.floor(latToTileY(bbox.n, z));
    const y1 = Math.floor(latToTileY(bbox.s, z));
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    if (nx * ny <= maxTiles || z === 9) return { z, x0, y0, nx, ny };
  }
}

/** Convertit des pixels RGBA Terrarium en altitudes (m). */
export function terrariumToElevation(rgba) {
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
  }
  return out;
}

/**
 * Télécharge et assemble les tuiles en une mosaïque.
 * decode(url) -> Promise<Float32Array(256*256)>
 */
export async function loadDem(bbox, decode, { maxTiles = 64, concurrency = 8, onProgress } = {}) {
  const plan = planTiles(bbox, maxTiles);
  const { z, x0, y0, nx, ny } = plan;
  const W = nx * TILE, H = ny * TILE;
  const data = new Float32Array(W * H);
  const jobs = [];
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) jobs.push([tx, ty]);
  let done = 0, next = 0;
  async function worker() {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      let tile;
      try {
        tile = await decode(TERRARIUM_URL(z, x0 + tx, y0 + ty));
      } catch (e) {
        // Une seconde tentative, puis on abandonne proprement.
        tile = await decode(TERRARIUM_URL(z, x0 + tx, y0 + ty));
      }
      for (let r = 0; r < TILE; r++) {
        data.set(tile.subarray(r * TILE, (r + 1) * TILE), (ty * TILE + r) * W + tx * TILE);
      }
      done++;
      onProgress?.(done / jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { z, x0, y0, nx, ny, W, H, data: smooth(data, W, H, z >= 14 ? 3 : 2) };
}

/** Flou « boîte » séparable : atténue le bruit du MNT (bâtiments, artefacts). */
function smooth(src, W, H, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const k = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += src[row + Math.min(W - 1, Math.max(0, x + d))];
      tmp[row + x] = s / k;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[Math.min(H - 1, Math.max(0, y + d)) * W + x];
      out[y * W + x] = s / k;
    }
  }
  return out;
}

/**
 * Échantillonneur bilinéaire. Deux types de grilles :
 *  - « merc » : mosaïque de tuiles Web Mercator (Terrarium) ;
 *  - « geo »  : grille régulière en lat/lon (IGN), avec repli sur dem.fallback
 *               là où l'IGN n'a pas de donnée.
 */
export function makeSampler(dem) {
  const fb = dem.fallback ? makeSampler(dem.fallback) : null;
  const { W, H, data } = dem;
  const bil = (px, py) => {
    px = Math.min(Math.max(px, 0), W - 1.001);
    py = Math.min(Math.max(py, 0), H - 1.001);
    const ix = Math.floor(px), iy = Math.floor(py);
    const fx = px - ix, fy = py - iy;
    const i = iy * W + ix;
    const a = data[i], b = data[i + 1], c = data[i + W], d = data[i + W + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  if (dem.kind === 'geo') {
    const { s, w, n, e } = dem;
    return (lat, lon) => {
      const v = bil(((lon - w) / (e - w)) * W - 0.5, ((n - lat) / (n - s)) * H - 0.5);
      return Number.isFinite(v) || !fb ? v : fb(lat, lon);
    };
  }
  const { z, x0, y0 } = dem;
  return (lat, lon) => bil((lonToTileX(lon, z) - x0) * TILE - 0.5, (latToTileY(lat, z) - y0) * TILE - 0.5);
}

// --- IGN RGE ALTI (France) ------------------------------------------------------
// Modèle numérique de TERRAIN (sol nu, sans bâtiments), licence ouverte Etalab.
// Bien plus fiable que le SRTM en ville. Service WMS raster de la Géoplateforme.

const IGN_WMS = 'https://data.geopf.fr/wms-r/wms';
const IGN_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';

export function inFrance(b) {
  return b.s > 41.2 && b.n < 51.3 && b.w > -5.6 && b.e < 9.9;
}

/** Télécharge la grille IGN couvrant la bbox (pas ~8 m) ; lève une erreur si inutilisable. */
export async function loadIgnDem(b, { resM = 8, maxPx = 2048 } = {}) {
  const latM = (b.n - b.s) * 111320;
  const lonM = (b.e - b.w) * 111320 * Math.cos(((b.n + b.s) / 2) * Math.PI / 180);
  const res = Math.max(resM, latM / maxPx, lonM / maxPx);
  const W = Math.ceil(lonM / res), H = Math.ceil(latM / res);
  const url = `${IGN_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${IGN_LAYER}&STYLES=` +
    `&CRS=EPSG:4326&BBOX=${b.s},${b.w},${b.n},${b.e}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/x-bil;bits=32`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IGN HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength !== W * H * 4) throw new Error('IGN : taille inattendue');
  const dv = new DataView(buf);
  const decode = (little) => {
    const out = new Float32Array(W * H);
    for (let i = 0; i < out.length; i++) {
      const v = dv.getFloat32(i * 4, little);
      out[i] = v > -1000 && v < 9000 ? v : NaN; // -99999 = pas de donnée
    }
    return out;
  };
  return { kind: 'geo', s: b.s, w: b.w, n: b.n, e: b.e, W, H, little: decode(true), big: decode(false) };
}

/**
 * Vérifie la grille IGN contre Terrarium (même ordre de grandeur, données présentes)
 * et choisit le bon boutisme. Renvoie un MNT prêt à l'emploi, ou null.
 */
export function validateIgn(ign, terrarium) {
  const ref = makeSampler(terrarium);
  for (const key of ['little', 'big']) {
    const dem = { kind: 'geo', s: ign.s, w: ign.w, n: ign.n, e: ign.e, W: ign.W, H: ign.H, data: ign[key] };
    const at = makeSampler(dem);
    const diffs = [];
    let valid = 0, total = 0;
    for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
      const lat = ign.s + (ign.n - ign.s) * i / 12, lon = ign.w + (ign.e - ign.w) * j / 12;
      const v = at(lat, lon);
      total++;
      if (Number.isFinite(v)) { valid++; diffs.push(Math.abs(v - ref(lat, lon))); }
    }
    if (valid < total * 0.5) continue;
    diffs.sort((a, b) => a - b);
    if (diffs[diffs.length >> 1] > 25) continue;
    dem.data = smoothNaN(dem.data, dem.W, dem.H);
    dem.fallback = terrarium;
    return dem;
  }
  return null;
}

/** Léger lissage 3×3 qui ignore les cases sans donnée. */
function smoothNaN(src, W, H) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
      const v = src[yy * W + xx];
      if (Number.isFinite(v)) { s += v; k++; }
    }
    out[y * W + x] = k ? s / k : NaN;
  }
  return out;
}

/** Décodeur pour le navigateur (thread principal). */
export async function browserDecode(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Tuile altitude ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(TILE, TILE)
    : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return terrariumToElevation(ctx.getImageData(0, 0, TILE, TILE).data);
}
