/**
 * How often each change passed `dmcr test` (round trip), for the Runner's test picker: a change that
 * already passed starts unticked. A count belongs to the change's files: editing deploy.sql, verify.sql
 * or revert.sql afterwards starts it at 0 again.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { findById, upsert } from '../../storage/db';

const COLLECTION = 'runner_test_passes';
type Passes = { count: number; fingerprint: string; lastAt: string };

/** md5 of the three files that decide a round trip; '' when the folder is missing. */
export function changeFingerprint(changesDir: string, id: string): string {
  const dir = path.join(changesDir, id);
  if (!/^[\w-]+$/.test(id) || !fs.existsSync(dir)) return '';
  const h = crypto.createHash('md5');
  for (const f of ['deploy.sql', 'verify.sql', 'revert.sql']) {
    const p = path.join(dir, f);
    h.update(f + '\0' + (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '') + '\0');
  }
  return h.digest('hex');
}

/** Count the changes a test run passed (status "pass"; setup and failures don't count). */
export function recordTestPasses(changesDir: string, changes: { change_id?: unknown; status?: unknown }[]): void {
  for (const c of changes) {
    const id = String(c.change_id ?? '');
    if (c.status !== 'pass' || !id) continue;
    const fingerprint = changeFingerprint(changesDir, id);
    if (!fingerprint) continue;
    const prev = findById<Passes>(COLLECTION, id);
    const count = prev && prev.fingerprint === fingerprint ? prev.count + 1 : 1;
    upsert<Passes>(COLLECTION, id, { count, fingerprint, lastAt: new Date().toISOString() });
  }
}

/** Passes per change for its current files (0 when never passed, or edited since). */
export function readTestPasses(changesDir: string, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const prev = findById<Passes>(COLLECTION, id);
    out[id] = prev && prev.fingerprint === changeFingerprint(changesDir, id) ? prev.count : 0;
  }
  return out;
}
