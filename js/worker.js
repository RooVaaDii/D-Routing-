// Web Worker : construction du graphe et optimisation, hors du thread de l'interface.
import { buildGraph } from './graph.js';
import { makeSampler } from './elevation.js';
import { solve } from './router.js';

let graph = null;

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'build') {
      const t0 = performance.now();
      const json = JSON.parse(msg.osmText);
      const sampler = makeSampler(msg.dem);
      graph = buildGraph(json.elements || [], sampler, msg.center);
      self.postMessage({ type: 'built', id: msg.id, nodes: graph.N, edges: graph.M, ms: performance.now() - t0 });
    } else if (msg.type === 'solve') {
      if (!graph) throw new Error('Graphe non chargé');
      const res = solve(graph, msg.params, (p) => self.postMessage({ type: 'progress', id: msg.id, ...summary(p) }));
      self.postMessage({ type: 'result', id: msg.id, result: res });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: msg.id, message: e.message || String(e) });
  }
};

function summary(p) {
  return { phase: p.phase, t: p.t, evals: p.evals, bestUp: p.best?.up, bestL: p.best?.L };
}
