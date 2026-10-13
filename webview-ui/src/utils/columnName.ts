/**
 * The name for a duplicated column: custom1 → custom2 (the next number not taken), code → code_2.
 * An empty name stays empty.
 */
export function nextColumnName(name: string, taken: string[]): string {
  const n = name.trim();
  if (!n) return '';
  const used = new Set(taken.map(t => t.trim().toLowerCase()));
  const m = /^(.*?)(\d+)$/.exec(n);
  const base = m ? m[1] : n + '_';
  let i = m ? Number(m[2]) + 1 : 2;
  while (used.has((base + i).toLowerCase())) i++;
  return base + i;
}
