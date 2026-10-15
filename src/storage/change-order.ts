/**
 * Change folders and their order. A change folder is <number>_<name>: 001_x … 999_x, then 1000_x and up
 * (DMCR numbers the next change one past the highest). They run in number order; a plain string sort puts
 * 1000_ before 101_, and a 3-digit-only match would leave out every change after the 999th.
 */
export const CHANGE_FOLDER_RX = /^\d{3,}_/;

export function isChangeFolder(name: string): boolean {
  return CHANGE_FOLDER_RX.test(name);
}

/** The folder number of a change id (001_x → 1, 1000_x → 1000); Infinity for anything else (R__ …). */
export function changeNum(id: string): number {
  const m = /^(\d+)_/.exec(id);
  return m ? Number(m[1]) : Infinity;
}

/** Folder-number order, then the name: 001 < 099 < 999 < 1000 < R__ … */
export function compareChangeIds(a: string, b: string): number {
  const na = changeNum(a), nb = changeNum(b);
  if (na !== nb) return na < nb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortChangeIds<T extends string>(ids: T[]): T[] {
  return ids.sort(compareChangeIds);
}
