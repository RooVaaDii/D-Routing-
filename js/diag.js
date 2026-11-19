// Diagnostic : journal des étapes (durées, cache, erreurs) toujours tenu en mémoire et dans la
// console ; panneau visible en ajoutant #diag à l'adresse (utile sur téléphone).
// Il montre aussi ce que sert le service worker : tuiles depuis le cache ou le réseau.

const lines = [];
let panel = null;
const t0 = performance.now();
const stamp = () => `${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s`;

export const diag = {
  log(msg) {
    lines.push(`${stamp()}  ${msg}`);
    if (lines.length > 60) lines.shift();
    console.info('[D+]', msg);
    render();
  },
};

/** Statistiques du service worker (compteurs cache / réseau et taille des caches). */
function swStats() {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    sw.postMessage({ type: 'stats' }, [ch.port2]);
  });
}

let sw = 'service worker : …';
async function refreshSw() {
  if (!panel) return;
  if (!('serviceWorker' in navigator)) { sw = 'service worker : non pris en charge'; return render(); }
  if (!navigator.serviceWorker.controller) { sw = 'service worker : pas encore actif (recharger la page une fois)'; return render(); }
  const s = await swStats();
  if (!s) { sw = 'service worker : ne répond pas'; return render(); }
  const f = (o) => `${o.cache} cache / ${o.net} réseau${o.err ? ` / ${o.err} erreurs` : ''}`;
  const size = (k) => Object.entries(s.sizes).find(([n]) => n.includes(k))?.[1] ?? 0;
  sw = [
    `tuiles : ${f(s.stats.tiles)} (${size('tiles')} en cache)`,
    `polices : ${f(s.stats.fonts)}`,
    `appli : ${f(s.stats.app)}`,
  ].join('\n');
  render();
}

function render() {
  if (!panel) return;
  panel.querySelector('pre').textContent = `${sw}\n\n${lines.slice(-18).join('\n')}`;
}

function mount() {
  if (panel || !/diag/.test(location.hash)) return;
  panel = document.createElement('div');
  panel.className = 'diag';
  panel.innerHTML = '<div class="diag-head"><b>Diagnostic</b><button type="button" aria-label="Fermer le diagnostic">×</button></div><pre></pre>';
  panel.querySelector('button').onclick = () => { location.hash = ''; panel.remove(); panel = null; };
  document.body.appendChild(panel);
  render();
  refreshSw();
  setInterval(refreshSw, 2000);
}
addEventListener('hashchange', mount);
mount();
