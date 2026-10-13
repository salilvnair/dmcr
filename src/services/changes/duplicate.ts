/**
 * A change saved twice: the same deploy.sql as a change folder that already exists (comments, spacing
 * and the change's own id aside). Saving it again would deploy the same thing twice under two ids.
 */
import * as fs from 'fs';
import * as path from 'path';

/** deploy.sql reduced to what it does: no comments, single spaces, its own change id as a placeholder. */
export function normalizeDeploySql(sql: string, ownId?: string): string {
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  if (ownId) s = s.split(ownId).join('__DMCR_CHANGE_ID__');
  return s.replace(/\s+/g, ' ').trim();
}

/** The existing numbered change whose deploy.sql does the same, or null. Repeatables (R__) are not compared. */
export function findDuplicateChange(changesDir: string, deploySql: string): string | null {
  const want = normalizeDeploySql(deploySql);
  if (!want || !fs.existsSync(changesDir)) return null;
  for (const d of fs.readdirSync(changesDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^\d{3,}_/.test(d.name)) continue;
    const f = path.join(changesDir, d.name, 'deploy.sql');
    if (!fs.existsSync(f)) continue;
    if (normalizeDeploySql(fs.readFileSync(f, 'utf8'), d.name) === want) return d.name;
  }
  return null;
}
