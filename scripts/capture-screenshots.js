// Regenerates the README screenshots under docs/screenshots/.
// Not a test — no assertions, just drives the real UI with Playwright and
// captures it. Reuses the same open()/loadSample() patterns as
// test/ui.test.js so these screenshots reflect real interaction, not a
// hand-crafted fixture.
//
//   npm run screenshots
//
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const FILE = path.resolve(__dirname, '..', 'job-tracker-v1.18.1.html');
const SAMPLE = path.resolve(__dirname, '..', 'sample-job-tracker-import.json');
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots');

async function welcome(page){
  await page.waitForTimeout(400);
  if(await page.locator('#welcomeOverlay.open').count()){
    await page.fill('#w-name', 'Derek');
    await page.click('#welcomeSubmitBtn');
    await page.waitForSelector('#welcomeOverlay.open', { state: 'detached' }).catch(()=>{});
    await page.waitForTimeout(300);
  }
}

async function loadSample(page){
  await page.evaluate(async (data) => {
    const f = new File([data], 'x.json', { type: 'application/json' });
    const dt = new DataTransfer(); dt.items.add(f);
    const inp = document.getElementById('importFile');
    inp.files = dt.files; inp.dispatchEvent(new Event('change'));
  }, fs.readFileSync(SAMPLE, 'utf8'));
  await page.waitForSelector('#dialogOverlay.open');
  await page.click('#dialogOkBtn');
  await page.waitForFunction(() => cards.length > 0);
  await page.waitForTimeout(400);
  // The sample data's dates read as old relative to whenever this script
  // runs, so card aging's decay fade would wash out nearly every card.
  // Turn it off directly (decayToggleCb isn't reachable in the mobile
  // layout) and re-render so screenshots show full-contrast cards.
  await page.evaluate(() => { decayEnabled = false; render(); });
  await page.waitForTimeout(200);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  async function open(opts = {}){
    const ctx = await browser.newContext({ viewport: { width: opts.width || 1600, height: opts.height || 1000 } });
    const page = await ctx.newPage();
    await page.goto('file://' + FILE);
    await page.waitForSelector('#syncBtn');
    await welcome(page);
    return page;
  }

  console.log('Capturing board view...');
  let page = await open();
  await loadSample(page);
  await page.screenshot({ path: path.join(OUT_DIR, 'board.png') });
  await page.context().close();

  console.log('Capturing postings grid view...');
  page = await open();
  await loadSample(page);
  await page.click('#viewPostingsBtn');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, 'postings-grid.png') });
  await page.context().close();

  console.log('Capturing mobile layout...');
  page = await open({ width: 390, height: 844 });
  await loadSample(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, 'mobile.png') });
  await page.context().close();

  await browser.close();
  console.log('Done: ' + OUT_DIR);
})();
