// Profil altimétrique dessiné sur un canvas, avec curseur synchronisé à la carte.

export function drawProfile(canvas, route, { hoverIdx = -1 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!route) return null;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--muted').trim() || '#666';
  const accent = css.getPropertyValue('--accent').trim() || '#e4572e';
  const pad = { l: 38, r: 8, t: 8, b: 18 };
  const D = route.distance || 1;
  let lo = route.minEle, hi = route.maxEle;
  const span = Math.max(hi - lo, 20);
  lo -= span * 0.08; hi = lo + span * 1.16;
  const X = (d) => pad.l + (d / D) * (w - pad.l - pad.r);
  const Y = (e) => pad.t + (1 - (e - lo) / (hi - lo)) * (h - pad.t - pad.b);

  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.globalAlpha = 0.25;
  const stepE = niceStep((hi - lo) / 3);
  ctx.globalAlpha = 1;
  for (let e = Math.ceil(lo / stepE) * stepE; e <= hi; e += stepE) {
    ctx.globalAlpha = 0.18; ctx.beginPath(); ctx.moveTo(pad.l, Y(e)); ctx.lineTo(w - pad.r, Y(e)); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillText(`${Math.round(e)}`, 4, Y(e) + 3);
  }
  const stepD = niceStep(D / 5 / 1000) * 1000;
  for (let d = 0; d <= D; d += stepD) ctx.fillText(`${(d / 1000).toFixed(stepD < 1000 ? 1 : 0)} km`, X(d) - 10, h - 4);

  ctx.beginPath();
  ctx.moveTo(X(0), Y(lo));
  for (let i = 0; i < route.ele.length; i++) ctx.lineTo(X(route.dist[i]), Y(route.ele[i]));
  ctx.lineTo(X(D), Y(lo));
  ctx.closePath();
  ctx.fillStyle = accent; ctx.globalAlpha = 0.22; ctx.fill(); ctx.globalAlpha = 1;
  ctx.beginPath();
  for (let i = 0; i < route.ele.length; i++) {
    const x = X(route.dist[i]), y = Y(route.ele[i]);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = accent; ctx.lineWidth = 1.6; ctx.stroke();

  if (hoverIdx >= 0) {
    const x = X(route.dist[hoverIdx]), y = Y(route.ele[hoverIdx]);
    ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 7); ctx.fill();
    const label = `${(route.dist[hoverIdx] / 1000).toFixed(2)} km · ${Math.round(route.ele[hoverIdx])} m`;
    ctx.fillStyle = ink; ctx.fillText(label, Math.min(x + 6, w - 110), pad.t + 10);
  }
  return { X, pad, w, D };
}

/** Index du point le plus proche d'une abscisse (en px) sur le profil. */
export function indexAt(route, px, geom) {
  const d = ((px - geom.pad.l) / (geom.w - geom.pad.l - geom.pad.r)) * geom.D;
  let lo = 0, hi = route.dist.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (route.dist[m] < d) lo = m; else hi = m; }
  return Math.abs(route.dist[lo] - d) < Math.abs(route.dist[hi] - d) ? lo : hi;
}

function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9)));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
