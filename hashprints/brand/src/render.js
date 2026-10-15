const { chromium } = require('/opt/node-tools/node_modules/playwright');
const path = require('path'), fs = require('fs');
const D = __dirname, seeds = JSON.parse(fs.readFileSync(path.join(D, 'seeds.json'), 'utf8'));
const SIZES = { 'pfp-print': [1000, 1000], 'pfp-mark': [1000, 1000], 'x-header': [1500, 500], 'banner-marketplace': [2800, 700], featured: [1200, 800], og: [1200, 630], 'discord-banner': [960, 540] };
(async () => {
  const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  for (const [name, [w, h]] of Object.entries(SIZES)) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto('file://' + path.join(D, 'brand.html'));
    await p.evaluate(([n, s]) => window.draw(n, s), [name, seeds]);
    await p.locator('#c').screenshot({ path: path.join(D, 'out', `hashprints-${name}.png`) });
    await p.close();
  }
  await b.close();
  for (const f of (fs.mkdirSync(path.join(D, 'out'), { recursive: true }), fs.readdirSync(path.join(D, 'out')))) console.log(f, fs.statSync(path.join(D, 'out', f)).size);
})();
