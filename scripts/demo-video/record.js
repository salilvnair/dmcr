// Records the README demo in one take against DMCR Web (start.ps1, after setup.ps1 + setup-ui.js).
// Each scene gets a caption; marks.json lists the stretches spent waiting on the AI or psql,
// which make-gif.js plays faster.
const fs = require('fs');
const path = require('path');
const { open, sleep, tab, btn, vis, cursor, click } = require('./lib');

const OUT = path.join(__dirname, '.output');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../../images/dmcr-icon.png')).toString('base64');
const text = page => page.evaluate(() => document.body.innerText);

let t0 = 0; const marks = [];
const now = () => (Date.now() - t0) / 1000;
async function waitFor(page, what, fn, timeout = 240000) {
  const start = now();
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) { marks.push({ from: start, to: now(), what }); return; } await sleep(250); }
  throw new Error(`timed out: ${what}`);
}

async function caption(page, step, words) {
  await page.evaluate(([step, words]) => {
    let c = document.getElementById('demo-caption');
    if (!c) {
      c = document.createElement('div'); c.id = 'demo-caption';
      c.style.cssText = 'position:fixed;left:50%;bottom:112px;transform:translateX(-50%);z-index:2147483646;display:flex;align-items:center;gap:12px;padding:12px 22px 12px 14px;border-radius:999px;background:rgba(15,15,25,.92);border:1px solid rgba(129,140,248,.55);box-shadow:0 10px 40px rgba(0,0,0,.55);font:600 23px/1.2 Inter,system-ui,sans-serif;color:#e0e7ff;pointer-events:none;transition:opacity .25s';
      document.body.appendChild(c);
    }
    c.style.opacity = '0';
    setTimeout(() => {
      c.innerHTML = `<span style="display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#6366f1;color:#fff;font-size:15px">${step}</span><span>${words}</span>`;
      c.style.opacity = '1';
    }, 200);
  }, [step, words]);
  await sleep(1000);
}

async function intro(page) {
  await page.setContent(`<html><body style="margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 35%,#1e1b4b 0%,#0b0b12 65%);font-family:Inter,system-ui,sans-serif;color:#e0e7ff">
    <div style="text-align:center">
      <img src="${icon}" style="width:150px;height:150px;opacity:0;transition:opacity .6s" id="i">
      <div id="t" style="font-size:96px;font-weight:800;letter-spacing:4px;margin-top:6px;min-height:116px;background:linear-gradient(90deg,#a5b4fc,#22d3ee);-webkit-background-clip:text;color:transparent"></div>
      <div id="s" style="font-size:28px;color:#c7d2fe;opacity:0;transition:opacity .6s">Database changes for PostgreSQL, from plain English to production</div>
      <div id="b" style="display:flex;gap:12px;justify-content:center;margin-top:30px;opacity:0;transition:opacity .6s">
        ${['deploy · verify · revert', 'releases & projects', 'dev → prod', 'two DBAs, one repo', 'VS Code + browser'].map(x => `<span style="padding:8px 16px;border-radius:999px;border:1px solid rgba(129,140,248,.5);background:rgba(99,102,241,.15);font-size:18px;color:#c7d2fe">${x}</span>`).join('')}
      </div>
    </div></body></html>`);
  await page.evaluate(() => { document.getElementById('i').style.opacity = 1; });
  await sleep(500);
  for (const ch of 'DMCR') { await page.evaluate(c => { document.getElementById('t').textContent += c; }, ch); await sleep(170); }
  await page.evaluate(() => { document.getElementById('s').style.opacity = 1; }); await sleep(700);
  await page.evaluate(() => { document.getElementById('b').style.opacity = 1; }); await sleep(3000);
}

(async () => {
  const { browser, context, page, startedAt } = await open({ video: OUT });
  t0 = startedAt;
  const introAt = now();
  await intro(page);
  marks.push({ introFrom: introAt, introTo: now() });
  await page.goto(require('./lib').URL);
  await page.waitForFunction(() => document.body.innerText.includes('Home'));
  await sleep(1500);
  await cursor(page);
  await page.mouse.move(700, 450);
  marks.push({ appReady: now() });

  // 1. plain English
  await tab(page, 'Assistant');
  await caption(page, 1, 'Describe the change in plain English');
  await click(page, btn(page, 'Start new chat')); await sleep(800);
  await click(page, vis(page.locator('.ce-composer-input')));
  await page.keyboard.type('Add a loyalty_points integer column to customers, not null, default 0', { delay: 24 });
  await sleep(500); await page.keyboard.press('Enter');
  await waitFor(page, 'metadata', async () => (await btn(page, 'Confirm & Generate').count()) > 0);
  const author = vis(page.getByPlaceholder('Your name or team alias'));
  await author.fill('dba-one');
  await sleep(1000);
  await click(page, btn(page, 'Confirm & Generate'));
  await waitFor(page, 'AI writes the change', async () => (await btn(page, 'Save to workspace').count()) > 0);
  await sleep(600);

  // 2. the three files, already test-run
  await vis(page.getByText('Self-check passed')).evaluate(e => e.scrollIntoView({ block: 'start' }));
  await caption(page, 2, 'Deploy, verify and revert, already test-run on dev');
  await sleep(1600);
  for (const f of ['verify.sql', 'revert.sql', 'deploy.sql']) { await click(page, btn(page, f)); await sleep(1300); }

  // 3. project + save + commit
  await caption(page, 3, 'Put it in a project and save: DMCR commits it to git');
  await click(page, btn(page, '(no project)')); await sleep(700);
  await click(page, vis(page.getByRole('option').filter({ hasText: 'LOYALTY' }))); await sleep(600);
  await click(page, vis(page.getByPlaceholder('Developer who asked')));
  await page.keyboard.type('maria', { delay: 60 }); await sleep(400);
  await click(page, btn(page, 'Save to workspace'));
  await waitFor(page, 'save', async () => (await btn(page, 'Commit').count()) > 0, 60000);
  await sleep(1200);
  await click(page, btn(page, 'Commit'));
  await waitFor(page, 'commit', async () => /Committed|pushed/i.test(await text(page)), 60000).catch(() => {});
  await sleep(1500);

  // 4. deploy the release to dev
  await tab(page, 'Releases');
  await waitFor(page, 'releases load', async () => !/Reading dev/.test(await text(page)) && /December release/.test(await text(page)), 60000);
  await caption(page, 4, 'Deploy the release to dev: a dry run first');
  await sleep(600);
  await click(page, btn(page, 'Deploy'));
  await waitFor(page, 'plan', async () => (await btn(page, 'Deploy in Runner').count()) > 0 && /will be deployed/.test(await text(page)), 60000);
  await sleep(1800);
  await click(page, btn(page, 'Deploy in Runner'));
  await waitFor(page, 'deploy dev', async () => /deployed successfully/.test(await text(page)), 120000);
  await sleep(2200);

  // 5. prod
  await tab(page, 'Releases');
  await waitFor(page, 'releases load 2', async () => !/Reading (dev|prod)/.test(await text(page)) && /December release/.test(await text(page)), 60000);
  await caption(page, 5, 'Then prod, with exactly what ran on dev');
  await click(page, btn(page, 'DEV dev')); await sleep(700);
  await click(page, vis(page.getByRole('option').filter({ hasText: 'prod' }))); await waitFor(page, 'releases load prod', async () => !/Reading (dev|prod)/.test(await text(page)), 60000);
  await sleep(500);
  await click(page, btn(page, 'Deploy'));
  await waitFor(page, 'plan prod', async () => /to prod/.test(await text(page)) && /will be deployed/.test(await text(page)), 60000);
  await sleep(2000);
  await click(page, btn(page, 'Deploy in Runner'));
  await waitFor(page, 'deploy prod', async () => /--env prod[\s\S]*deployed successfully/.test(await text(page)), 120000);
  await sleep(2200);

  // 6. history in git
  await tab(page, 'Commits');
  await caption(page, 6, 'Every save and every deploy is a commit');
  await sleep(2800);

  // 7. variables
  await caption(page, 7, '${app_role} becomes each environment\'s own role');
  await click(page, btn(page, 'Variables')); await sleep(3800);
  marks.push({ end: now() });

  fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify(marks, null, 2));
  const video = page.video();
  await context.close(); await browser.close();
  fs.renameSync(await video.path(), path.join(OUT, 'take.webm'));
  console.log('recorded', path.join(OUT, 'take.webm'), marks.filter(m => m.what && m.to).map(m => `${m.what} ${(m.to - m.from).toFixed(1)}s`).join(', '));
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
