/**
 * Theme files: what Export writes and Import reads. One file can carry app palettes and terminal themes:
 *
 *   { "dmcr.theme": 1, "themes": [ { "kind": "app", ... }, { "kind": "terminal", ... } ] }
 *
 * Daakia's theme files ("daakia.theme") use the same shape, so they import here as they are; an app palette
 * with only a dark half gets a derived light half (marked lightDerived). Terminal themes are parsed by DUI.
 */
import { parseTerminalThemes, type TerminalPalette } from '@salilvnair/dui';
import { SEED_KEYS, deriveLightSeeds, type AppPalette, type AppSeeds } from './palette';
import { IDENTITY_FAMILIES, type Family } from './tokens';

export const THEME_FORMAT = 'dmcr.theme';
export const THEME_VERSION = 1;
export const MAX_THEMES_STORED = 200;
const MAX_FILE_BYTES = 2_000_000;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v.trim());

export type ThemeFileParse =
  | { ok: true; app: AppPalette[]; terminal: TerminalPalette[] }
  | { ok: false; error: string };

function seedsOf(raw: unknown, where: string): AppSeeds | string {
  if (!raw || typeof raw !== 'object') return `${where} is missing its colours.`;
  const o = raw as Record<string, unknown>;
  const out = {} as AppSeeds;
  for (const key of SEED_KEYS) {
    if (!isHex(o[key])) return `${where} has no valid ${key} colour.`;
    out[key] = (o[key] as string).trim().toLowerCase();
  }
  return out;
}

function paletteOf(raw: unknown, where: string): AppPalette | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${where} is not a theme.`;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null;
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : null;
  if (!id) return `${where} has no id.`;
  if (!label) return `${where} has no name.`;
  const dark = seedsOf(o.dark, `"${label}"`);
  if (typeof dark === 'string') return dark;
  let light = seedsOf(o.light, `"${label}"`);
  let lightDerived = false;
  if (typeof light === 'string') { light = deriveLightSeeds(dark); lightDerived = true; }
  const identity: Partial<Record<Family, string>> = {};
  if (o.identity && typeof o.identity === 'object') {
    for (const f of IDENTITY_FAMILIES) { const v = (o.identity as Record<string, unknown>)[f]; if (isHex(v)) identity[f] = (v as string).trim().toLowerCase(); }
  }
  const overrides: Record<string, string> = {};
  if (o.overrides && typeof o.overrides === 'object') {
    for (const [name, value] of Object.entries(o.overrides as Record<string, unknown>)) {
      if (/^--[\w-]+$/.test(name) && isHex(value)) overrides[name] = (value as string).trim().toLowerCase();
    }
  }
  return {
    id, label, swatch: isHex(o.swatch) ? (o.swatch as string).trim().toLowerCase() : dark.accent, dark, light,
    ...(lightDerived ? { lightDerived: true } : {}),
    ...(Object.keys(identity).length ? { identity } : {}),
    ...(Object.keys(overrides).length ? { overrides } : {}),
  };
}

/** Parse a theme file (text or object): app palettes and terminal themes, all or nothing. */
export function parseThemeFile(input: unknown): ThemeFileParse {
  let raw = input;
  if (typeof raw === 'string') {
    if (raw.length > MAX_FILE_BYTES) return { ok: false, error: 'That file is too large to be a theme.' };
    try { raw = JSON.parse(raw); } catch { return { ok: false, error: 'That is not valid JSON.' }; }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'That is not a theme file.' };
  let appEntries: unknown[] = [];
  let termEntries: unknown[] = [];
  if (Array.isArray(raw)) appEntries = raw;
  else {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.themes)) {
      for (const t of o.themes) {
        const kind = (t as Record<string, unknown>)?.kind;
        if (kind === 'terminal') termEntries.push(t); else if (kind === undefined || kind === 'app') appEntries.push(t);
      }
    } else if (Array.isArray(o.app) || Array.isArray(o.terminal)) {
      appEntries = Array.isArray(o.app) ? o.app : [];
      termEntries = Array.isArray(o.terminal) ? o.terminal : [];
    } else if (o['dui.terminalTheme'] !== undefined) {
      termEntries = Array.isArray(o.themes) ? o.themes : [];
    } else appEntries = [raw];
  }
  if (appEntries.length + termEntries.length === 0) return { ok: false, error: 'That file has no themes in it.' };
  if (appEntries.length + termEntries.length > MAX_THEMES_STORED) return { ok: false, error: `That file has more than ${MAX_THEMES_STORED} themes in it.` };
  const app: AppPalette[] = [];
  for (let i = 0; i < appEntries.length; i++) {
    const p = paletteOf(appEntries[i], `Theme ${i + 1}`);
    if (typeof p === 'string') return { ok: false, error: p };
    app.push(p);
  }
  let terminal: TerminalPalette[] = [];
  if (termEntries.length) {
    const t = parseTerminalThemes({ 'dui.terminalTheme': 1, themes: termEntries.map(e => { const { kind: _k, ...rest } = e as Record<string, unknown>; return rest; }) });
    if (!t.ok) return { ok: false, error: `Terminal theme: ${t.error}` };
    terminal = t.themes;
  }
  return { ok: true, app, terminal };
}

/** One file with app palettes and terminal themes (built-in flags stripped). */
export function serializeThemeFile(app: AppPalette[], terminal: TerminalPalette[] = []): string {
  return JSON.stringify({
    [THEME_FORMAT]: THEME_VERSION,
    themes: [
      ...app.map(({ builtIn: _b, ...p }) => ({ kind: 'app' as const, ...p })),
      ...terminal.map(t => ({ kind: 'terminal' as const, ...t })),
    ],
  }, null, 2);
}

/** Save text as a file: a real download in DMCR Web, the save dialog in VS Code. */
export function downloadText(filename: string, text: string, post: (m: unknown) => void): void {
  if (location.protocol.startsWith('http')) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } else {
    post({ type: 'saveTextFile', payload: { content: text, filename, filters: { 'Theme': ['json'] } } });
  }
}
