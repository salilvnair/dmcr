/**
 * How many rows a long list shows per page (Settings › Lists): 10 by default, or 15, 20, 25, 50, 100.
 * Every paged list (Releases changes, Runner results, the test picker, deploy previews) starts at this size,
 * and shows its search, filters and page footer once it has more rows than one page.
 * Saved with the extension's settings (DMCR Web and VS Code alike), cached here for the first paint.
 */
import { useSyncExternalStore } from 'react';
import { postMsg } from '../vscode';

export const PAGE_SIZES = [10, 15, 20, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 10;
export type ListPrefs = { pageSize: number };

const KEY = 'dmcr.listPrefs.v1';
const valid = (n: unknown): n is number => typeof n === 'number' && (PAGE_SIZES as readonly number[]).includes(n);

let prefs: ListPrefs = readCache();
const listeners = new Set<() => void>();

function readCache(): ListPrefs {
  try { const raw = localStorage.getItem(KEY); const p = raw ? JSON.parse(raw) : null; if (p && valid(p.pageSize)) return { pageSize: p.pageSize }; } catch { /* no storage */ }
  return { pageSize: DEFAULT_PAGE_SIZE };
}

function commit(next: ListPrefs, persist: boolean) {
  prefs = next;
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* still applied */ }
  if (persist) postMsg({ type: 'saveListPrefs', payload: prefs });
  listeners.forEach(l => l());
}

/** The saved preferences from the extension (init message). */
export function hydrateListPrefs(saved: Partial<ListPrefs> | undefined) {
  if (saved && valid(saved.pageSize)) commit({ pageSize: saved.pageSize }, false);
}

export function setPageSize(n: number) {
  if (valid(n)) commit({ ...prefs, pageSize: n }, true);
}

export function usePageSize(): number {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => prefs.pageSize);
}
