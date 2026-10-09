/**
 * The schema a form should show: the saved one when it is offered, else the first offered one.
 * The server offers 'public' first; a restored draft may still hold DMCR's own 'dmcr' registry
 * schema (or one that no longer exists), which must never be preselected.
 */
export function pickSchema(saved: string | undefined | null, offered: string[]): string {
  if (!offered.length) return saved || '';
  return saved && offered.includes(saved) ? saved : offered[0];
}
