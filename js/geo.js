// Petites fonctions géographiques partagées (navigateur, worker et Node).

export const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Projection équirectangulaire locale (mètres) autour d'un point de référence. */
export function makeProjection(lat0, lon0) {
  const kx = Math.cos(lat0 * RAD) * EARTH_R * RAD;
  const ky = EARTH_R * RAD;
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

/** Boîte englobante (sud, ouest, nord, est) d'un cercle de rayon r mètres. */
export function bboxAround(lat, lon, r) {
  const dLat = r / (EARTH_R * RAD);
  const dLon = r / (EARTH_R * RAD * Math.cos(lat * RAD));
  return { s: lat - dLat, w: lon - dLon, n: lat + dLat, e: lon + dLon };
}

// --- Tuiles Web Mercator -------------------------------------------------

export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat, z) {
  const r = lat * RAD;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/** Pseudo-aléatoire reproductible (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
