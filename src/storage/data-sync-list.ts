/**
 * Data Diff's sync list: the objects (kind|name) and rules (rule|prefix_*, rule|!pattern) whose rows or definitions
 * are kept the same on every environment. Kept in data-sync.json in the changes folder, next to releases.json, so it
 * is committed with the changes and every DBA on the repo sees the same list.
 */
import * as fs from 'fs';
import * as path from 'path';
import { requireChangesDir } from './changes-dir';

export const DATA_SYNC_FILE = 'data-sync.json';

export type DataSyncList = {
  items: string[];
  /** the file, relative to the changes folder */
  file: string;
  /** edited here and not committed yet */
  uncommitted: boolean;
  error?: string;
};

export const dataSyncFile = () => path.join(requireChangesDir(), DATA_SYNC_FILE);

/** sorted, one of each, only kind|name or rule|pattern */
export function cleanItems(items: unknown[]): string[] {
  return [...new Set(items.filter((x): x is string => typeof x === 'string' && /^[a-z]+\|.+/.test(x.trim())).map(x => x.trim()))].sort();
}

export async function readDataSyncList(): Promise<DataSyncList> {
  let items: string[] = [], error: string | undefined, file = '';
  try {
    file = dataSyncFile();
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { items?: unknown[] };
      items = cleanItems(Array.isArray(j.items) ? j.items : []);
    } else {
      // before it lived in the repo it was kept per user: carried over until the first save writes the file
      const { findById } = await import('./db.js');
      items = cleanItems(findById<{ items?: unknown[] }>('data_diff', 'sync_list')?.items ?? []);
    }
  } catch (e) {
    error = `${DATA_SYNC_FILE}: ${e instanceof Error ? e.message : String(e)}`;
  }
  let uncommitted = false;
  try {
    const { isGitRepo, getUnstagedChanges } = await import('../services/git/git-service.js');
    if (file && fs.existsSync(file) && await isGitRepo()) uncommitted = (await getUnstagedChanges(file)).length > 0;
  } catch { /* no git: nothing to commit */ }
  return { items, file: DATA_SYNC_FILE, uncommitted, error };
}

export function writeDataSyncList(items: unknown[]): void {
  const file = dataSyncFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    $comment: 'Data Diff sync list: kind|name, rule|prefix_* (keeps), rule|!pattern (leaves out). Edit it in DMCR > Diff > Data > Edit.',
    items: cleanItems(items),
  }, null, 2) + '\n', 'utf8');
}
