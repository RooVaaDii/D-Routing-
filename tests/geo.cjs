const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } });
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, geolocation: { latitude: 48.8830, longitude: 2.3150 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('pageerror:', e.message));
    await page.route(/overpass/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' }));
    await page.goto('http://127.0.0.1:8080/');
    await page.waitForTimeout(800);
    await page.click('#geoBtn');
    await page.waitForTimeout(2500);
    console.log(vp.width, 'adresse :', await page.inputValue('#address'), '| hint :', await page.textContent('#hint'));
    await page.screenshot({ path: `${process.argv[2]}/geo-${vp.width}.png` });
  }
  await browser.close();
})();
