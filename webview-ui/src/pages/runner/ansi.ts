// ─── ANSI color shorthands (standard codes → mapped by xterm theme) ───────────
export const CI  = '\x1b[34m';   // blue (indigo primary)
export const CB  = '\x1b[37m';   // white (slate bright)
export const CD  = '\x1b[90m';   // bright-black (slate dim)
export const CG  = '\x1b[32m';   // green (success)
export const CR  = '\x1b[31m';   // red (error)
export const CY  = '\x1b[33m';   // yellow (warn)
export const CC  = '\x1b[36m';   // cyan (info)
export const CM  = '\x1b[35m';   // magenta
export const RST = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM  = '\x1b[2m';

// ─── ANSI-aware visible width (strips escape codes before measuring) ────────────
export function visLen(s: string): number {
  return s.replace(/\x1b\[[\d;]*m/g, '').length;
}

export function padToW(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - visLen(s)));
}
