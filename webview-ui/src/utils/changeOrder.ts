/** Folder-number order of change ids, as the runner deploys them: 001 < 099 < 999 < 1000 (a string sort puts 1000_ before 101_). */
export function changeNum(id: string): number {
  const m = /^(\d+)_/.exec(id);
  return m ? Number(m[1]) : Infinity;
}

export function compareChangeIds(a: string, b: string): number {
  const na = changeNum(a), nb = changeNum(b);
  if (na !== nb) return na < nb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
