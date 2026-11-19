// Petit worker pour l'animation du chargement : découpe le réseau OSM en anneaux de distance
// autour du départ (GeoJSON prêt pour la carte). N'intervient pas dans le calcul du parcours.

self.onmessage = (ev) => {
  const { osmText, center: [lat0, lon0], radius, rings } = ev.data;
  let els = [];
  try { els = JSON.parse(osmText).elements || []; } catch { /* réponse illisible : rien à montrer */ }
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 111320;
  const ringOf = (lat, lon) => {
    const d = Math.hypot((lon - lon0) * kx, (lat - lat0) * ky);
    // Anneaux serrés près du départ (rayon ∝ i²) : on les voit apparaître même zoomé.
    return d > radius * 1.05 ? -1 : Math.min(rings - 1, Math.floor(Math.sqrt(d / radius) * rings));
  };
  const parts = Array.from({ length: rings }, () => []);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  for (const el of els) {
    const g = el.geometry;
    if (el.type !== 'way' || !g || g.length < 2) continue;
    // Morceaux de quelques points, chacun rangé dans l'anneau de son milieu.
    for (let i = 0; i < g.length - 1; i += 6) {
      const seg = g.slice(i, Math.min(g.length, i + 7));
      const mid = seg[seg.length >> 1];
      const r = ringOf(mid.lat, mid.lon);
      if (r < 0) continue;
      parts[r].push(seg.map((p) => [r6(p.lon), r6(p.lat)]));
    }
  }
  self.postMessage({
    type: 'FeatureCollection',
    features: parts.map((coords, r) => ({ type: 'Feature', properties: { r }, geometry: { type: 'MultiLineString', coordinates: coords } })),
  });
};
