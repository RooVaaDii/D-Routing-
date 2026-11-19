// Diagnostic : journal des étapes (réglages, zone, tuiles, durées, mémoire, cache, erreurs),
// tenu en mémoire, dans la console et dans le téléphone (localStorage) : si iOS recharge la page
// faute de mémoire, le journal de la session précédente reste lisible.
// Panneau visible en ajoutant #diag à l'adresse ; bouton « Copier » pour le transmettre.

const KEY = 'dplus-diag-v1';
const MAX = 300;
const lines = [];
let panel = null;
const t0 = performance.now();
const stamp = () => `${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s`;

let previous = [];
try { previous = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { previous = []; }
let saveTimer = 0;
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(lines.slice(-MAX))); } catch { /* stockage plein ou privé */ }
  }, 300);
};

export const diag = {
  log(msg) {
    lines.push(`${stamp()}  ${msg}`);
    if (lines.length > MAX) lines.shift();
    console.info('[D+]', msg);
    persist();
    render();
  },
  /** Mémoire utilisée par la page, si le navigateur l'indique (pas Safari). */
  memory() {
    const m = performance.memory;
    return m ? `${Math.round(m.usedJSHeapSize / 1e6)} Mo utilisés / ${Math.round(m.jsHeapSizeLimit / 1e6)} Mo max` : 'non indiquée par ce navigateur';
  },
};

// Contexte de l'appareil, en tête du journal
diag.log(`appareil : ${navigator.userAgent}`);
diag.log(`écran ${innerWidth}×${innerHeight} @${devicePixelRatio}x, mémoire de l'appareil ${navigator.deviceMemory ? navigator.deviceMemory + ' Go' : 'inconnue'}, cœurs ${navigator.hardwareConcurrency || '?'}`);
if (previous.length) diag.log(`session précédente : ${previous.length} lignes gardées (voir plus bas)`);

// Erreurs non rattrapées : elles apparaissent aussi dans le journal
addEventListener('error', (e) => diag.log(`erreur : ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
addEventListener('unhandledrejection', (e) => diag.log(`promesse rejetée : ${e.reason?.message || e.reason}`));

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
  sw = [`tuiles : ${f(s.stats.tiles)} (${size('tiles')} en cache)`, `polices : ${f(s.stats.fonts)}`, `appli : ${f(s.stats.app)}`].join('\n');
  render();
}

const fullText = () => [
  'D+ Routing — diagnostic', location.href, sw, `mémoire : ${diag.memory()}`, '',
  '— Cette session —', ...lines, '',
  ...(previous.length ? ['— Session précédente —', ...previous] : []),
].join('\n');

function render() {
  if (!panel) return;
  const pre = panel.querySelector('pre');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = `${sw}\nmémoire : ${diag.memory()}\n\n${lines.join('\n')}${previous.length ? `\n\n— session précédente —\n${previous.join('\n')}` : ''}`;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

async function copy() {
  const btn = panel.querySelector('[data-copy]');
  const text = fullText();
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copié'; } catch {
    // Presse-papiers refusé : on sélectionne le texte pour une copie manuelle.
    const r = document.createRange(); r.selectNodeContents(panel.querySelector('pre'));
    getSelection().removeAllRanges(); getSelection().addRange(r);
    btn.textContent = 'Sélectionné';
  }
  setTimeout(() => { btn.textContent = 'Copier'; }, 1500);
}

function mount() {
  if (panel || !/diag/.test(location.hash)) return;
  panel = document.createElement('div');
  panel.className = 'diag';
  panel.innerHTML = `<div class="diag-head"><b>Diagnostic</b><span>
    <button type="button" data-copy>Copier</button>
    <button type="button" data-clear>Effacer</button>
    <button type="button" data-close aria-label="Fermer le diagnostic">×</button></span></div><pre></pre>`;
  panel.querySelector('[data-copy]').onclick = copy;
  panel.querySelector('[data-clear]').onclick = () => { previous = []; lines.length = 0; try { localStorage.removeItem(KEY); } catch { /* */ } render(); };
  panel.querySelector('[data-close]').onclick = () => { location.hash = ''; panel.remove(); panel = null; };
  document.body.appendChild(panel);
  render();
  refreshSw();
  setInterval(refreshSw, 2000);
}
addEventListener('hashchange', mount);
mount();
