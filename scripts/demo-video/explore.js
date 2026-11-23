// node explore.js "Tab" ... -> clicks each text in order, prints controls of main + text
const { open, dump, sleep } = require('./lib');
(async () => {
  const { browser, page } = await open();
  for (const a of process.argv.slice(2)) { await (['Home','DDL','DML','Freeform','Manual','Diff','Assistant','Releases','Runner','Commits','Settings'].includes(a) ? require('./lib').tab(page, a) : Promise.reject()).catch(() => require('./lib').btn(page, a).click({ force: true })); await sleep(2500); }
  console.log(await dump(page, 'main'));
  const t = await page.evaluate(() => (document.querySelector('main') || document.body).innerText); console.log('---\n' + t.slice(0, 2500));
  await page.screenshot({ path: 'C:/dmcr-demo/explore.png' });
  await browser.close();
})();
