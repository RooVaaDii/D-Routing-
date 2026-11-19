// Test de bout en bout de l'interface. Overpass est simulé (inaccessible depuis ce
// conteneur) ; altitudes réelles (Terrarium) ; polices servies localement.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2] || '.';
const [lat0, lon0] = [48.8566, 2.3522];
function fakeOsm() {
  const n = 60, step = 0.0011, els = []; let wid = 1;
  for (let i = 0; i < n; i++) for (const h of [true, false]) {
    const nodes = [], geometry = [];
    for (let j = 0; j < n; j++) { const [a, b] = h ? [i, j] : [j, i]; nodes.push(a * n + b + 1); geometry.push({ lat: lat0 - 0.033 + a * step, lon: lon0 - 0.046 + b * step * 1.4 }); }
    els.push({ type: 'way', id: wid++, nodes, geometry, tags: { highway: i % 4 ? 'residential' : 'path' } });
  }
  return JSON.stringify({ elements: els });
}
const fontDir = path.join(__dirname, 'node_modules/@fontsource-variable/archivo/files');
const monoDir = path.join(__dirname, 'node_modules/@fontsource/jetbrains-mono/files');
const fontCss = `
@font-face{font-family:"Archivo";src:url(https://fonts.local/archivo.woff2) format("woff2");font-weight:100 900;font-stretch:62% 125%;}
@font-face{font-family:"JetBrains Mono";src:url(https://fonts.local/mono400.woff2) format("woff2");font-weight:400;}
@font-face{font-family:"JetBrains Mono";src:url(https://fonts.local/mono600.woff2) format("woff2");font-weight:600;}`;

async function run(name, viewport, mode) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('console:', m.text()); });
  await page.route(/overpass/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fakeOsm() }));
  await page.route(/nominatim/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ address: { house_number: '12', road: 'Rue de Test', city: 'Lyon' } }) }));
  await page.route(/fonts\.googleapis/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fontCss }));
  await page.route(/fonts\.local/, (r) => {
    const u = r.request().url();
    const f = u.includes('archivo') ? path.join(fontDir, 'archivo-latin-standard-normal.woff2') : path.join(monoDir, u.includes('600') ? 'jetbrains-mono-latin-600-normal.woff2' : 'jetbrains-mono-latin-400-normal.woff2');
    r.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(f), headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto('http://127.0.0.1:8080/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${name}-1-setup.png` });
  await page.mouse.click(viewport.width > 720 ? viewport.width * 0.7 : viewport.width / 2, viewport.width > 720 ? viewport.height / 2 : 130);
  await page.waitForTimeout(2500); // préchargement
  console.log(name, 'préchargement :', await page.textContent('#preload'));
  const runOnce = async (tag) => {
    await page.click('#go');
    await page.waitForTimeout(tag === 'loop' ? 2200 : 1200);
    await page.screenshot({ path: `${OUT}/${name}-${tag}-search.png` });
    await page.waitForFunction(() => document.querySelector('#sheet').dataset.state !== 'search', null, { timeout: 60000 });
    await page.waitForTimeout(2600);
    console.log(name, tag, 'état:', await page.evaluate(() => document.querySelector('#sheet').dataset.state), '| hint:', await page.textContent('#hint'),
      '| D+', await page.textContent('#rUp'), '| km', await page.textContent('#rDist'), '|', (await page.textContent('#rClimb')) || '',
      '| étapes:', (await page.textContent('#steps')).replace(/\s+/g, ' '));
    await page.screenshot({ path: `${OUT}/${name}-${tag}-result.png` });
  };
  await runOnce('loop');
  await page.click('#edit');
  await page.click('input[value=repeat] + span');
  await page.click('#repsPlus'); await page.click('#repsPlus');
  await runOnce('circuit');
  await browser.close();
}
(async () => {
  await run('mobile', { width: 390, height: 844 });
  await run('desktop', { width: 1280, height: 800 });
})();
