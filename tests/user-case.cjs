// Cas réel signalé : 19 rue Dulong (Paris 17e), 20 km ±10 %, parcours varié, même côte 1 fois.
// Vraies tuiles OpenFreeMap ; seul Nominatim est simulé. Affiche le diagnostic complet.
const { chromium } = require('playwright');
const OUT = process.argv[2] || '.';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.route(/nominatim/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ lat: '48.8848', lon: '2.3147', display_name: '19 Rue Dulong, Paris, France' }]) }));
  await page.goto('http://127.0.0.1:8080/#diag');
  await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('dplus-cache'); });
  await page.reload(); await page.waitForTimeout(1500);
  await page.fill('#address', '19 rue Dulong'); await page.press('#address', 'Enter');
  await page.fill('#dist', '20'); await page.dispatchEvent('#dist', 'input'); await page.dispatchEvent('#dist', 'change');
  await page.click('input[name=tol][value="0.1"] + span');
  await page.click('input[name=cap][value="1"] + span');
  await page.waitForTimeout(800);
  const t0 = Date.now();
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#sheet').dataset.state !== 'search', null, { timeout: 240000 });
  console.log('fin en', ((Date.now() - t0) / 1000).toFixed(1), 's | état', await page.evaluate(() => document.querySelector('#sheet').dataset.state),
    '| D+', await page.textContent('#rUp'), '| km', await page.textContent('#rDist'), '|', await page.textContent('#hint'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/user-case.png` });
  console.log(await page.textContent('.diag pre'));
  await browser.close();
})();
