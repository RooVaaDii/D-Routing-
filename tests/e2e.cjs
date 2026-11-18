// Test de bout en bout : la réponse Overpass est simulée (bloquée depuis ce conteneur),
// les tuiles d'altitude et le reste sont réels.
const { chromium } = require('playwright');
const lat0 = 45.7640, lon0 = 4.8357, n = 60, step = 0.0011;
function fakeOsm() {
  const els = []; let wid = 1;
  const id = (i, j) => i * n + j + 1;
  for (let i = 0; i < n; i++) for (const h of [true, false]) {
    const nodes = [], geometry = [];
    for (let j = 0; j < n; j++) {
      const [a, b] = h ? [i, j] : [j, i];
      nodes.push(id(a, b)); geometry.push({ lat: lat0 - 0.033 + a * step, lon: lon0 - 0.046 + b * step * 1.4 });
    }
    els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: i % 4 ? 'residential' : 'path' } });
  }
  return JSON.stringify({ elements: els });
}
(async () => {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  page.on('console', (m) => console.log('console:', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.route(/overpass/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fakeOsm() }));
  await page.goto('http://127.0.0.1:8080/');
  await page.waitForTimeout(1500);
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.width / 2, 200);
  for (const mode of ['loop', 'repeat']) {
    await page.click(`input[value=${mode}] + span`);
    await page.click('#go');
    await page.waitForFunction(() => !document.querySelector('#go').disabled, null, { timeout: 60000 });
    console.log(mode, '→', await page.textContent('#status'));
    console.log('  stats:', (await page.textContent('#stats')).replace(/\s+/g, ' '));
    await page.screenshot({ path: `${process.argv[2]}/shot-${mode}.png` });
  }
  await browser.close();
})();
