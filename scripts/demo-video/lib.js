// Shared helpers for the demo recorder: Playwright from the daakia checkout (dmcr does not depend on it).
const path = require('path');
const { chromium } = require(require.resolve('playwright', { paths: [path.join(__dirname, '../../../daakia')] }));
const W = Number(process.env.DEMO_W || 1440), H = Number(process.env.DEMO_H || 900);
const URL = process.env.DEMO_URL || 'http://127.0.0.1:7841/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open({ video } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark',
    ...(video ? { recordVideo: { dir: video, size: { width: W, height: H } } } : {}) });
  const page = await context.newPage();
  const startedAt = Date.now();
  await page.goto(URL);
  await page.waitForFunction(() => document.body.innerText.includes('Home'), null, { timeout: 30000 });
  await sleep(1500);
  return { browser, context, page, startedAt };
}

/** Visible inputs and buttons, for finding selectors. */
async function dump(page, within = 'body') {
  return page.evaluate(sel => {
    const root = document.querySelector(sel) || document.body;
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out = [];
    for (const e of root.querySelectorAll('input, textarea, select, button, [role=tab], [contenteditable=true]')) {
      if (!vis(e)) continue;
      out.push(`${e.tagName.toLowerCase()}${e.type ? ':' + e.type : ''} | ${(e.getAttribute('placeholder') || e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || e.value || '').trim().slice(0, 60).replace(/\n/g, ' ')}`);
    }
    return out.join('\n');
  }, within);
}

/** Moves a visible cursor dot with the mouse, so clicks read in the recording. */
async function cursor(page) {
  await page.addStyleTag({ content: '#demo-cursor{position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(129,140,248,.55);border:2px solid #c7d2fe;pointer-events:none;transition:transform .12s}#demo-cursor.down{transform:scale(.7)}' });
  await page.evaluate(() => {
    const c = document.createElement('div'); c.id = 'demo-cursor'; c.style.left = '-50px'; c.style.top = '-50px'; document.body.appendChild(c);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => c.classList.add('down'), true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  });
}

/** Glide to an element and click it. */
async function click(page, locator, { pause = 350 } = {}) {
  const l = typeof locator === 'string' ? page.locator(locator).first() : locator;
  await l.evaluate(e => e.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  const b = await l.boundingBox();
  if (!b) { await l.click({ force: true }); return; }
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 }); await sleep(pause);
  await l.click({ force: true });
}

async function type(page, locator, text, delay = 28) {
  const l = typeof locator === 'string' ? page.locator(locator).first() : locator;
  await click(page, l, { pause: 200 });
  await l.pressSequentially(text, { delay });
}

module.exports = { open, dump, cursor, click, type, sleep, URL };
/** Top-bar tab by its label. */
async function tab(page, name) {
  const l = page.locator(`button.bs-topbar-tab[data-label="${name}"]`).first();
  const b = await l.boundingBox();
  if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 }); await sleep(300); }
  await l.evaluate(e => e.click()); await sleep(1500);
}
module.exports.tab = tab;
/** The visible button with this name (hidden tabs keep their own copies mounted). */
const btn = (page, name, exact = true) => page.getByRole('button', { name, exact }).locator('visible=true').first();
const vis = (l) => l.locator('visible=true').first();
module.exports.btn = btn; module.exports.vis = vis;
