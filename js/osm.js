// Téléchargement du réseau praticable à pied depuis OpenStreetMap (API Overpass).

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const HIGHWAYS = [
  'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street', 'service', 'pedestrian', 'road',
  'track', 'path', 'footway', 'bridleway', 'cycleway', 'steps',
];

export function overpassQuery(b) {
  const bbox = `${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)}`;
  return `[out:json][timeout:90][maxsize:536870912];
way["highway"~"^(${HIGHWAYS.join('|')})$"]["area"!="yes"]["service"!~"^(parking_aisle|driveway|drive-through)$"]["access"!~"^(private|no)$"]["foot"!~"^(no|private)$"](${bbox});
out body geom qt;
way["highway"~"^(${HIGHWAYS.join('|')})$"]["access"~"^(private|no)$"]["foot"~"^(yes|designated|permissive)$"](${bbox});
out body geom qt;`;
}

/** Récupère le JSON brut (texte) en essayant plusieurs serveurs Overpass. */
export async function fetchOsm(bbox, { signal, onStatus } = {}) {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      onStatus?.(`Réseau OSM : ${new URL(url).host}…`);
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trimStart().startsWith('{')) throw new Error('Réponse Overpass invalide');
      return text;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw new Error(`Impossible de joindre Overpass (${lastErr?.message ?? 'erreur'})`);
}
