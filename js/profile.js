// Profil altimétrique coloré selon la pente, avec curseur synchronisé à la carte.

export const GRADE_COLORS = ['#2440FF', '#12B5A6', '#FFB000', '#FF4F1A', '#FF2D8E'];
const LIMITS = [-0.03, 0.03, 0.06, 0.10];

export function gradeClass(g) {
  let k = 0;
  while (k < LIMITS.length && g > LIMITS[k]) k++;
  return k;
}

/** Pente lissée (fenêtre ±75 m) en chaque point du tracé. */
export function grades(route, half = 75) {
  const n = route.ele.length, out = new Float32Array(n);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    while (route.dist[i] - route.dist[a] > half) a++;
    while (b < n - 1 && route.dist[b + 1] - route.dist[i] <= half) b++;
    const dd = route.dist[b] - route.dist[a];
    out[i] = dd > 5 ? (route.ele[b] - route.ele[a]) / dd : 0;
  }
  return out;
}

export function drawProfile(canvas, route, { hoverIdx = -1, reveal = 1 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!route) return null;
  const pad = { l: 30, r: 4, t: 10, b: 16 };
  const D = route.distance || 1;
  const span = Math.max(route.maxEle - route.minEle, 20);
  const lo = route.minEle - span * 0.06, hi = lo + span * 1.12;
  const X = (d) => pad.l + (d / D) * (w - pad.l - pad.r);
  const Y = (e) => pad.t + (1 - (e - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const base = h - pad.b;

  // Axes discrets
  ctx.font = '600 9px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = '#5D6573';
  ctx.strokeStyle = '#E1E4EA';
  ctx.lineWidth = 1;
  const stepE = niceStep((hi - lo) / 3);
  for (let e = Math.ceil(lo / stepE) * stepE; e <= hi; e += stepE) {
    const y = Math.round(Y(e)) + 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(`${Math.round(e)}`, 0, y + 3);
  }
  const stepD = niceStep(D / 5 / 1000) * 1000;
  for (let d = stepD; d < D; d += stepD) ctx.fillText(`${+(d / 1000).toFixed(1)}K`, X(d) - 8, h - 3);

  // Aire colorée par tranche de pente
  const g = route._grades || (route._grades = grades(route));
  const lim = D * reveal;
  for (let i = 1; i < route.ele.length; i++) {
    if (route.dist[i - 1] > lim) break;
    const x0 = X(route.dist[i - 1]), x1 = X(Math.min(route.dist[i], lim)) + 0.6;
    const c = GRADE_COLORS[gradeClass(g[i])];
    ctx.fillStyle = c;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(x0, base); ctx.lineTo(x0, Y(route.ele[i - 1])); ctx.lineTo(x1, Y(route.ele[i])); ctx.lineTo(x1, base);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Ligne d'encre
  ctx.beginPath();
  for (let i = 0; i < route.ele.length && route.dist[i] <= lim; i++) {
    const x = X(route.dist[i]), y = Y(route.ele[i]);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = '#0D1015'; ctx.lineWidth = 1.6; ctx.stroke();

  if (hoverIdx >= 0) {
    const x = X(route.dist[hoverIdx]), y = Y(route.ele[hoverIdx]);
    ctx.strokeStyle = '#0D1015'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, pad.t - 6); ctx.lineTo(x, base); ctx.stroke();
    ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
    ctx.lineWidth = 2.5; ctx.stroke();
    const label = `${(route.dist[hoverIdx] / 1000).toFixed(2)} KM · ${Math.round(route.ele[hoverIdx])} M · ${(g[hoverIdx] * 100).toFixed(0)} %`;
    ctx.font = '600 10px "JetBrains Mono", ui-monospace, monospace';
    const tw = ctx.measureText(label).width + 12;
    const lx = Math.min(Math.max(x - tw / 2, pad.l), w - tw);
    ctx.fillStyle = '#0D1015';
    roundRect(ctx, lx, 0, tw, 17, 5); ctx.fill();
    ctx.fillStyle = '#D9FF3B'; ctx.fillText(label, lx + 6, 12);
  }
  return { pad, w, D };
}

/** Index du point le plus proche d'une abscisse (en px) sur le profil. */
export function indexAt(route, px, geom) {
  const d = ((px - geom.pad.l) / (geom.w - geom.pad.l - geom.pad.r)) * geom.D;
  let lo = 0, hi = route.dist.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (route.dist[m] < d) lo = m; else hi = m; }
  return Math.abs(route.dist[lo] - d) < Math.abs(route.dist[hi] - d) ? lo : hi;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9)));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
