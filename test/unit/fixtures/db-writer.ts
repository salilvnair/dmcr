/**
 * Child process for the multi-process SQLite test: opens the shared DB like a VS Code window,
 * writes `count` rows with small random pauses (so debounced saves and file-watch reloads from
 * other processes interleave), then closes (final save).
 * argv: <extensionDir> <writerName> <count>
 */
import * as path from 'node:path';

async function main() {
  const [extDir, name, countText] = process.argv.slice(2);
  const db = require(path.resolve(__dirname, '..', '..', '..', 'src', 'storage', 'db')) as typeof import('../../../src/storage/db');
  await db.initDb(extDir);
  const count = Number(countText);
  for (let i = 0; i < count; i++) {
    db.upsert('stress', `${name}-${i}`, { name, i });
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 60)));
  }
  db.closeDb();
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
