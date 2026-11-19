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
  'service', 'sac_scale', 'smoothness', 'footway', 'area', 'name', 'ref'];

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

/** Temps d'attente (s) annoncé par un serveur Overpass avant qu'une place se libère. */
async function slotWait(url) {
  try {
    const res = await fetch(url.replace(/interpreter$/, 'status'), { signal: AbortSignal.timeout?.(5000) });
    const txt = await res.text();
    if (/slots? available now/i.test(txt)) return 1;
    const secs = [...txt.matchAll(/in (\d+) seconds/g)].map((m) => +m[1]);
    return secs.length ? Math.min(...secs) + 1 : 10;
  } catch { return 10; }
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); });
});

/**
 * Récupère le JSON brut (texte) en essayant plusieurs serveurs Overpass.
 * Un serveur « occupé » (429 / 504 : places limitées par adresse IP, et une requête abandonnée
 * continue d'en occuper une) est attendu puis réessayé avant de passer au suivant.
 */
export async function fetchOsm(bbox, { onStatus, onLog, timeoutMs = 35000, signal } = {}) {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    const host = new URL(url).host;
    const name = host.split('.').slice(-2, -1)[0];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) break;
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      signal?.addEventListener('abort', stop);
      const t0 = performance.now();
      let received = 0;
      const tick = setInterval(() => {
        const s = Math.round((performance.now() - t0) / 1000);
        onStatus?.(received ? `${(received / 1e6).toFixed(1)} Mo` : `${name} · ${s} s`);
      }, 500);
      // Délai max pour obtenir le début de la réponse ; ensuite on laisse finir.
      let timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let busy = false;
      try {
        const res = await fetch(url, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: ctrl.signal,
        });
        if (res.status === 429 || res.status === 504) { busy = true; throw new Error(`${host} : occupé (HTTP ${res.status})`); }
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
        onLog?.(`${host} : ${(text.length / 1e6).toFixed(1)} Mo en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        return text;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error(`${host} : pas de réponse`) : e;
        console.warn(lastErr.message);
        onLog?.(lastErr.message);
      } finally {
        clearTimeout(timer);
        clearInterval(tick);
        signal?.removeEventListener('abort', stop);
      }
      if (!busy || attempt === 2) break;
      // Serveur occupé : on attend qu'une place se libère, puis on réessaie le même serveur.
      const w = Math.min(await slotWait(url), 45);
      onLog?.(`${host} : place libre dans ${w} s, on attend`);
      const until = performance.now() + w * 1000;
      const count = setInterval(() => onStatus?.(`serveur occupé · ${Math.max(0, Math.round((until - performance.now()) / 1000))} s`), 500);
      await sleep(w * 1000, signal);
      clearInterval(count);
    }
  }
  if (signal?.aborted) throw new DOMException('Téléchargement annulé', 'AbortError');
  throw new Error(`Impossible de récupérer les données OSM (${lastErr?.message ?? 'erreur'}). Réessaie dans un moment ou avec une distance plus courte.`);
}
