/**
 * Mocha entry point for the end-to-end suite, loaded by VS Code's extension host
 * (see scripts/e2e/run-e2e.mjs). Runs every *.e2e.js file next to this one.
 */
import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 180_000 });
  for (const f of fs.readdirSync(__dirname)) {
    if (f.endsWith('.e2e.js')) { mocha.addFile(path.join(__dirname, f)); }
  }
  return new Promise((resolve, reject) => {
    mocha.run(failures => (failures > 0 ? reject(new Error(`${failures} end-to-end test(s) failed`)) : resolve()));
  });
}
