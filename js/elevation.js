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
  return { z, x0, y0, nx, ny, W, H, data };
}

/** Échantillonneur bilinéaire sur la mosaïque. */
export function makeSampler(dem) {
  const { z, x0, y0, W, H, data } = dem;
  return (lat, lon) => {
    let px = (lonToTileX(lon, z) - x0) * TILE - 0.5;
    let py = (latToTileY(lat, z) - y0) * TILE - 0.5;
    px = Math.min(Math.max(px, 0), W - 1.001);
    py = Math.min(Math.max(py, 0), H - 1.001);
    const ix = Math.floor(px), iy = Math.floor(py);
    const fx = px - ix, fy = py - iy;
    const i = iy * W + ix;
    const a = data[i], b = data[i + 1], c = data[i + W], d = data[i + W + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
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
