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

// Tags réellement utilisés par le graphe : on allège la réponse (énorme en ville sinon).
const KEEP_TAGS = ['highway', 'surface', 'tracktype', 'bridge', 'tunnel', 'access', 'foot',
  'service', 'sac_scale', 'smoothness', 'footway', 'area'];

export function overpassQuery(b) {
  const bbox = `${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)}`;
  const hw = `["highway"~"^(${HIGHWAYS.join('|')})$"]`;
  return `[out:json][timeout:60][maxsize:268435456][bbox:${bbox}];
(
  way${hw}["area"!="yes"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"]["footway"!~"^(sidewalk|crossing|traffic_island|access_aisle)$"]["access"!~"^(private|no)$"]["foot"!~"^(no|private)$"];
  way${hw}["access"~"^(private|no)$"]["foot"~"^(yes|designated|permissive)$"];
);
out body geom qt;`;
}

/** Ne garde que les tags utiles et les coordonnées (réduit la mémoire). */
export function slimOsm(text) {
  const js = JSON.parse(text);
  const elements = [];
  for (const el of js.elements || []) {
    if (el.type !== 'way') continue;
    const tags = {};
    for (const k of KEEP_TAGS) if (el.tags?.[k] !== undefined) tags[k] = el.tags[k];
    elements.push({ type: 'way', id: el.id, nodes: el.nodes, geometry: el.geometry, tags });
  }
  return { elements };
}

/** Récupère le JSON brut (texte) en essayant plusieurs serveurs Overpass. */
export async function fetchOsm(bbox, { onStatus, timeoutMs = 35000 } = {}) {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    const host = new URL(url).host;
    const ctrl = new AbortController();
    const t0 = performance.now();
    let received = 0;
    const tick = setInterval(() => {
      const s = Math.round((performance.now() - t0) / 1000);
      onStatus?.(received
        ? `Réseau OSM : ${(received / 1e6).toFixed(1)} Mo reçus (${s} s)…`
        : `Réseau OSM : ${host} prépare les données (${s} s)…`);
    }, 500);
    // Délai max pour obtenir le début de la réponse ; ensuite on laisse finir.
    let timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${host} : HTTP ${res.status}`);
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), 120000);
      let text;
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const parts = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          parts.push(dec.decode(value, { stream: true }));
        }
        parts.push(dec.decode());
        text = parts.join('');
      } else {
        text = await res.text();
      }
      if (!text.trimStart().startsWith('{')) throw new Error(`${host} : réponse invalide`);
      if (/"remark":\s*"runtime error/.test(text.slice(-2000))) throw new Error(`${host} : délai dépassé côté serveur`);
      return text;
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`${host} : pas de réponse`) : e;
      console.warn(lastErr.message);
    } finally {
      clearTimeout(timer);
      clearInterval(tick);
    }
  }
  throw new Error(`Impossible de récupérer les données OSM (${lastErr?.message ?? 'erreur'}). Réessaie dans un moment ou avec une distance plus courte.`);
}
