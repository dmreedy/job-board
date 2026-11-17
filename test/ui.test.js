// UI regression tests for the job tracker (Playwright + headless Chromium).
//
//   npm i -D playwright        # or use a globally installed playwright
//   node test/ui.test.js job-tracker-vX.Y.Z.html
//
// Set CHROMIUM_PATH to use a specific Chromium binary. External network is
// never touched: the sync backend is mocked with page.route.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const FILE = path.resolve(process.argv[2] || path.resolve(__dirname, '..', 'job-tracker-v1.18.1.html'));
const SAMPLE = path.resolve(__dirname, '..', 'sample-job-tracker-import.json');
const SYNC_URL = 'https://script.google.com/macros/s/TEST/exec';

let pass = 0, fail = 0;
async function test(name, fn){
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch(e){ fail++; console.log('  FAIL ' + name + '\n       ' + (e.message||e).split('\n')[0]); }
}
const assert = (c, m) => { if(!c) throw new Error(m || 'assertion failed'); };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  // First run shows a welcome dialog that requires a name.
  async function welcome(page){
    await page.waitForTimeout(400);
    if(await page.locator('#welcomeOverlay.open').count()){
      await page.fill('#w-name', 'Derek');
      await page.click('#welcomeSubmitBtn');
      await page.waitForSelector('#welcomeOverlay.open', { state: 'detached' }).catch(()=>{});
      await page.waitForTimeout(300);
    }
  }
  async function open(opts = {}){
    const ctx = await browser.newContext({ viewport: { width: opts.width || 1600, height: 1000 } }); ctx.setDefaultTimeout(4000);
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    await page.goto('file://' + FILE);
    await page.waitForSelector('#syncBtn');
    await welcome(page);
    return page;
  }
  async function loadSample(page){
    await page.evaluate(async (data) => {
      const f = new File([data], 'x.json', { type: 'application/json' });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.getElementById('importFile');
      inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    }, fs.readFileSync(SAMPLE, 'utf8'));
    // Import asks replace-vs-merge; OK = replace.
    await page.waitForSelector('#dialogOverlay.open');
    await page.click('#dialogOkBtn');
    await page.waitForFunction(() => cards.length > 0);
    await page.waitForTimeout(300);
  }
  const syncClass = p => p.evaluate(() => [...document.getElementById('syncBtn').classList].filter(c => c.startsWith('sync-')));

  console.log('Loading + layout');
  await test('page loads without script errors', async () => {
    const p = await open(); assert(p.errors.length === 0, p.errors.join('; ')); await p.context().close();
  });
  await test('control bar line-1 elements are 34px tall and vertically centered', async () => {
    const p = await open(); await loadSample(p);
    const r = await p.evaluate(() => ['#viewBoardBtn','#searchInput','#tagFilterInput','#undoBtn','#openPaste','#openAdd','#syncBtn','#settingsBtn','#exportBtn','#importBtn']
      .map(s => { const e = document.querySelector(s); if(!e || e.offsetParent === null) return null; const b = e.getBoundingClientRect(); return { s, h: Math.round(b.height), cy: b.top + b.height/2 }; }).filter(Boolean));
    assert(r.length >= 8, 'too few controls visible: ' + r.length);
    r.forEach(x => assert(x.h === 34, `${x.s} height ${x.h}`));
    const spread = Math.max(...r.map(x => x.cy)) - Math.min(...r.map(x => x.cy));
    assert(spread <= 1, 'vertical center spread ' + spread.toFixed(2) + 'px');
    await p.context().close();
  });
  await test('search inputs share height, font and radius', async () => {
    const p = await open(); await loadSample(p);
    const r = await p.evaluate(() => ['#searchInput','#tagFilterInput'].map(s => { const c = getComputedStyle(document.querySelector(s)); return [c.height, c.fontFamily, c.fontSize, c.borderRadius].join('|'); }));
    assert(r[0] === r[1], r.join(' vs ')); await p.context().close();
  });
  await test('tag array is capped at two pill rows and scrolls vertically only', async () => {
    const p = await open(); await loadSample(p);
    const r = await p.evaluate(() => { const e = document.getElementById('filterbarScroll'); const c = getComputedStyle(e); return { mh: parseFloat(c.maxHeight), ox: c.overflowX, h: e.getBoundingClientRect().height }; });
    assert(r.mh <= 60 && r.h <= 60, JSON.stringify(r)); assert(r.ox !== 'scroll', 'horizontal scroll enabled');
    await p.context().close();
  });

  console.log('Import / filters / undo');
  await test('sample import loads ~100 cards', async () => {
    const p = await open(); await loadSample(p);
    const n = await p.evaluate(() => cards.filter(c => !c.deleted).length); assert(n >= 90, 'cards: ' + n);
    await p.context().close();
  });
  await test('tag filter narrows the pill array; Reset Filters restores it', async () => {
    const p = await open(); await loadSample(p);
    const total = await p.locator('#filterbarScroll .ftag').count();
    await p.fill('#tagFilterInput', 'from:'); await p.waitForTimeout(150);
    const some = await p.locator('#filterbarScroll .ftag').count();
    assert(some > 0 && some < total, `filtered ${some} of ${total}`);
    await p.click('#resetColumnWidthsWrap button, #resetColumnWidthsWrap'); await p.waitForTimeout(150);
    assert(await p.inputValue('#tagFilterInput') === '', 'tag query not reset');
    await p.context().close();
  });

  console.log('Duplicate detection / Replace Existing Card');
  async function addCard(p, role, company){
    await p.click('#openAdd'); await p.fill('#f-role', role); await p.fill('#f-company', company); await p.click('#saveBtn'); await p.waitForTimeout(250);
  }
  await test('duplicate prompt offers Create Anyway / Replace / Cancel', async () => {
    const p = await open(); await loadSample(p); await addCard(p, 'Staff Engineer', 'Acme');
    await p.click('#openAdd'); await p.fill('#f-role', 'Staff Engineer'); await p.fill('#f-company', 'Acme'); await p.click('#saveBtn');
    await p.waitForSelector('#dialogAltBtn', { state: 'visible' });
    const t = await p.evaluate(() => ['dialogOkBtn','dialogAltBtn','dialogCancelBtn'].map(i => document.getElementById(i).textContent.trim()));
    assert(t.join('|') === 'Create Anyway|Replace Existing Card|Cancel', t.join('|'));
    await p.context().close();
  });
  await test('Cancel keeps one card', async () => {
    const p = await open(); await loadSample(p); await addCard(p, 'Dup', 'Co');
    const base = await p.evaluate(() => cards.filter(c => !c.deleted).length);
    await p.click('#openAdd'); await p.fill('#f-role', 'Dup'); await p.fill('#f-company', 'Co'); await p.click('#saveBtn');
    await p.click('#dialogCancelBtn'); await p.waitForTimeout(200);
    assert(await p.evaluate(() => cards.filter(c => !c.deleted).length) === base, 'count changed');
    await p.context().close();
  });
  await test('Create Anyway keeps both cards', async () => {
    const p = await open(); await loadSample(p); await addCard(p, 'Dup', 'Co');
    const base = await p.evaluate(() => cards.filter(c => !c.deleted).length);
    await p.click('#openAdd'); await p.fill('#f-role', 'Dup'); await p.fill('#f-company', 'Co'); await p.click('#saveBtn');
    await p.click('#dialogOkBtn'); await p.waitForTimeout(250);
    assert(await p.evaluate(() => cards.filter(c => !c.deleted).length) === base + 1, 'expected one more');
    await p.context().close();
  });
  await test('Replace tombstones the old card, adds the new one; Undo restores', async () => {
    const p = await open(); await loadSample(p); await addCard(p, 'Dup', 'Co');
    const base = await p.evaluate(() => cards.filter(c => !c.deleted).length);
    const oldId = await p.evaluate(() => cards.find(c => c.role === 'Dup').id);
    await p.click('#openAdd'); await p.fill('#f-role', 'Dup'); await p.fill('#f-company', 'Co'); await p.click('#saveBtn');
    await p.click('#dialogAltBtn'); await p.waitForTimeout(250);
    let s = await p.evaluate(id => ({ live: cards.filter(c => !c.deleted).length, oldDeleted: cards.find(c => c.id === id).deleted === true, stamped: !!cards.find(c => c.id === id).updatedAt }), oldId);
    assert(s.live === base && s.oldDeleted && s.stamped, JSON.stringify(s));
    await p.click('#undoBtn'); await p.waitForTimeout(250);
    s = await p.evaluate(id => ({ live: cards.filter(c => !c.deleted).length, oldDeleted: cards.find(c => c.id === id).deleted === true }), oldId);
    assert(s.live === base && !s.oldDeleted, 'undo: ' + JSON.stringify(s));
    await p.context().close();
  });

  console.log('Sync status indicator (mocked backend)');
  async function openSynced(handler){
    const p = await open();
    await p.route(SYNC_URL + '**', handler);
    await p.evaluate(u => { localStorage.setItem('job-tracker-sync-url', u); localStorage.setItem('job-tracker-sync-secret', 'k'); }, SYNC_URL);
    await p.reload(); await p.waitForSelector('#syncBtn'); await welcome(p); await p.waitForTimeout(600);
    return p;
  }
  await test('no sync URL: button disabled and idle', async () => {
    const p = await open();
    assert(await p.evaluate(() => document.getElementById('syncBtn').disabled), 'not disabled');
    assert((await syncClass(p)).includes('sync-idle'), 'not idle'); await p.context().close();
  });
  await test('failed sync: red ring + instant tooltip with reason', async () => {
    const p = await openSynced(r => r.fulfill({ status: 500, body: 'boom' }));
    await p.evaluate(() => document.getElementById('syncBtn').click()).catch(()=>{});
    await p.waitForFunction(() => document.getElementById('syncBtn').classList.contains('sync-failed'), null, { timeout: 30000 }).catch(()=>{});
    assert((await syncClass(p)).includes('sync-failed'), 'class: ' + await syncClass(p));
    await p.hover('#syncBtn'); await p.waitForTimeout(100);
    const tip = await p.evaluate(() => { const t = document.getElementById('syncTip'); return t && getComputedStyle(t).display !== 'none' && t.textContent.trim(); });
    assert(tip && tip.length > 3, 'no tooltip'); await p.context().close();
  });
  await test('successful sync clears failed/dirty state', async () => {
    const p = await openSynced(r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cards: [], users: [], resumes: {} }) }));
    await p.evaluate(() => document.getElementById('syncBtn').click()); await p.waitForTimeout(800);
    const c = await syncClass(p); assert(!c.includes('sync-failed') && !c.includes('sync-running'), c.join(','));
    await p.context().close();
  });
  await test('sync requests are POST with key in body, never in URL', async () => {
    let seen = null;
    const p = await openSynced(r => { seen = { method: r.request().method(), url: r.request().url(), body: r.request().postData() }; r.fulfill({ status: 200, contentType: 'application/json', body: '{"cards":[],"users":[],"resumes":{}}' }); });
    await p.evaluate(() => document.getElementById('syncBtn').click()); await p.waitForTimeout(600);
    assert(seen && seen.method === 'POST', 'method ' + (seen && seen.method));
    assert(!/key=/.test(seen.url), 'key in URL'); assert(/"key"/.test(seen.body || ''), 'key missing from body');
    await p.context().close();
  });

  console.log('Mobile');
  await test('mobile layout (390px) loads without errors and relocates sync controls', async () => {
    const p = await open({ width: 390 }); await p.waitForTimeout(300);
    assert(p.errors.length === 0, p.errors.join('; '));
    const inMobile = await p.evaluate(() => !!document.querySelector('#mHeaderSync #syncBtn, #mHeaderActions #settingsBtn'));
    assert(inMobile, 'sync/settings not relocated'); await p.context().close();
  });

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
