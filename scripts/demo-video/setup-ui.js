// First-run setup through the DMCR Web UI, before the recording (not recorded):
// the two databases, the changes folder, the DBA name, each database set up, then a release and a project.
const fs = require('fs');
const { open, sleep, tab, btn } = require('./lib');
const pw = JSON.parse(fs.readFileSync('C:/dmcr-demo/passwords.json', 'utf8').replace(/^\uFEFF/, ''));
const text = page => page.evaluate(() => document.body.innerText);

(async () => {
  const { browser, page } = await open();
  const envs = [
    ['postgresql://shop_dbo_st@localhost:5442/shop_test', 'shop_dbo_st', 'shop_st', pw.test],
    ['postgresql://shop_dbo@localhost:5442/shop_prod', 'shop_dbo', 'shop', pw.prod],
  ];
  for (let i = 0; i < 2; i++) {
    await page.getByPlaceholder('postgresql://user@host:5432/database').nth(i).fill(envs[i][0]);
    await page.getByPlaceholder('schema (empty: public)').nth(i).fill(envs[i][1]);
    await page.getByPlaceholder('app role (optional)').nth(i).fill(envs[i][2]);
    await page.locator('input[type=password]').nth(i).fill(envs[i][3]);
  }
  await btn(page, 'Save databases').click({ force: true }); await sleep(3000);
  await page.getByPlaceholder('db/changes').fill('db/changes'); await btn(page, 'Save').click({ force: true }); await sleep(2500);
  await page.getByPlaceholder('DBA name').fill('dba-one'); await btn(page, 'Save').click({ force: true }); await sleep(2500);
  await btn(page, 'Set up all (2)').click({ force: true });
  for (let i = 0; i < 30 && !(await text(page)).includes('6 of 6 done'); i++) await sleep(1000);
  if (!(await text(page)).includes('6 of 6 done')) throw new Error('setup did not finish');

  await tab(page, 'Releases');
  await btn(page, 'New release').click({ force: true }); await sleep(800);
  await page.getByPlaceholder('Release id').fill('2026-12-01'); await page.getByPlaceholder('Release name').fill('December release');
  await btn(page, 'Save').click({ force: true }); await sleep(3000);
  await btn(page, 'New project').click({ force: true }); await sleep(1000);
  await page.getByPlaceholder('Project id').fill('LOYALTY'); await page.getByPlaceholder('Project name').fill('Loyalty points');
  await btn(page, 'Save').click({ force: true }); await sleep(3000);
  if (!(await text(page)).includes('Loyalty points')) throw new Error('project not created');
  await tab(page, 'Home');
  console.log('setup done');
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
