/**
 * The theme state (app palettes and terminal themes) and painting it on the page.
 *
 * App palette: one <style id="dmcr-palette"> appended last to <head>, so it wins over index.css without a more
 * specific selector; DMCR's own palette removes it (the stylesheet as it ships).
 * Terminal theme: <style id="dmcr-terminal"> with --dm-term-* for the Runner terminal, always written.
 *
 * Saved in the extension (globalState, so it follows VS Code and DMCR Web), cached in localStorage for the first paint.
 */
import { useSyncExternalStore } from 'react';
import { TERMINAL_PALETTES, resolveTerminalTheme, type TerminalPalette } from '@salilvnair/dui';
import { BUILT_IN_PALETTES, DEFAULT_PALETTE_ID, paletteCss, type AppPalette } from './palette';
import { tokenValues } from './tokens';
import { XTERM_THEME, XTERM_THEME_LIGHT } from '../../pages/runner/themes';
import { postMsg } from '../../vscode';

export type ThemeState = {
  custom: AppPalette[];
  selected: string;
  hidden: string[];
  order: string[];
  terminalCustom: TerminalPalette[];
  terminalSelected: string;
  terminalHidden: string[];
};

const CACHE_KEY = 'dmcr.themes.v1';
const EMPTY: ThemeState = { custom: [], selected: DEFAULT_PALETTE_ID, hidden: [], order: [], terminalCustom: [], terminalSelected: 'dmcr', terminalHidden: [] };

/** DMCR's own terminal colours as a terminal theme (the Runner's defaults). */
const ansi = (t: typeof XTERM_THEME) => ({
  foreground: t.foreground, cursor: t.cursor, selectionBackground: t.selectionBackground,
  black: t.black, red: t.red, green: t.green, yellow: t.yellow, blue: t.blue, magenta: t.magenta, cyan: t.cyan, white: t.white,
  brightBlack: t.brightBlack, brightRed: t.brightRed, brightGreen: t.brightGreen, brightYellow: t.brightYellow,
  brightBlue: t.brightBlue, brightMagenta: t.brightMagenta, brightCyan: t.brightCyan, brightWhite: t.brightWhite,
});
export const DMCR_TERMINAL: TerminalPalette = { id: 'dmcr', label: 'DMCR', swatch: '#818cf8', dark: ansi(XTERM_THEME), light: ansi(XTERM_THEME_LIGHT) };
export const BUILT_IN_TERMINALS: TerminalPalette[] = [DMCR_TERMINAL, ...TERMINAL_PALETTES];

let state: ThemeState = readCache();
let mode: 'dark' | 'light' = 'dark';
const listeners = new Set<() => void>();

function readCache(): ThemeState {
  try { const raw = localStorage.getItem(CACHE_KEY); if (raw) return { ...EMPTY, ...JSON.parse(raw) }; } catch { /* no storage */ }
  return EMPTY;
}

function commit(next: ThemeState, persist = true) {
  state = next;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)); } catch { /* still applied */ }
  if (persist) postMsg({ type: 'saveThemeState', payload: state });
  paint();
  listeners.forEach(l => l());
}

/** Every app palette in display order: built-ins and custom ones, by the saved order. */
export function allPalettes(s: ThemeState = state): AppPalette[] {
  const all = [...BUILT_IN_PALETTES, ...s.custom];
  const rank = (id: string) => { const i = s.order.indexOf(id); return i < 0 ? 1e6 + all.findIndex(p => p.id === id) : i; };
  return all.sort((a, b) => rank(a.id) - rank(b.id));
}
export function allTerminals(s: ThemeState = state): TerminalPalette[] { return [...BUILT_IN_TERMINALS, ...s.terminalCustom]; }

export function currentPalette(): AppPalette { return allPalettes().find(p => p.id === state.selected) ?? BUILT_IN_PALETTES[0]; }
export function currentTerminal(): TerminalPalette { return allTerminals().find(t => t.id === state.terminalSelected) ?? DMCR_TERMINAL; }

function styleEl(id: string): HTMLStyleElement {
  const e = document.getElementById(id);
  if (e instanceof HTMLStyleElement) return e;
  const el = document.createElement('style'); el.id = id; document.head.appendChild(el); return el;
}

/** Paint both, for the current mode. `preview` paints an app palette without selecting it. */
export function paint(preview?: AppPalette | null) {
  const p = preview ?? currentPalette();
  if (p.id === DEFAULT_PALETTE_ID && !preview) document.getElementById('dmcr-palette')?.remove();
  else styleEl('dmcr-palette').textContent = paletteCss(p, mode);
  // the terminal sits on the app's terminal surface (--dm-c-0d1117 / f8fafc), recomputed by the palette
  const seeds = mode === 'dark' ? p.dark : p.light;
  const ground = p.id === DEFAULT_PALETTE_ID ? (mode === 'dark' ? '#0d1117' : '#f8fafc') : (tokenValues(seeds)[mode === 'dark' ? '--dm-c-0d1117' : '--dm-c-f8fafc'] ?? seeds.surface);
  const t = resolveTerminalTheme(currentTerminal(), mode, ground);
  styleEl('dmcr-terminal').textContent = `:root, [data-theme] {\n${Object.entries(t).map(([k, v]) => `  --dm-term-${k}: ${v};`).join('\n')}\n  --dm-term-background: ${ground};\n}`;
}

export function setMode(m: 'dark' | 'light') { mode = m; paint(); }
export function hydrate(saved: Partial<ThemeState> | undefined) { if (saved) commit({ ...EMPTY, ...saved }, false); else paint(); }

export const themeActions = {
  select: (id: string) => commit({ ...state, selected: id }),
  add: (p: AppPalette) => commit({ ...state, custom: [...state.custom.filter(x => x.id !== p.id), { ...p, builtIn: undefined }], selected: p.id }),
  update: (p: AppPalette) => commit({ ...state, custom: state.custom.map(x => (x.id === p.id ? { ...p, builtIn: undefined } : x)) }),
  remove: (id: string) => commit({ ...state, custom: state.custom.filter(x => x.id !== id), selected: state.selected === id ? DEFAULT_PALETTE_ID : state.selected }),
  setHidden: (id: string, hidden: boolean) => commit({ ...state, hidden: hidden ? [...new Set([...state.hidden, id])] : state.hidden.filter(h => h !== id) }),
  reorder: (ids: string[]) => commit({ ...state, order: ids }),
  importApp: (ps: AppPalette[]) => commit({ ...state, custom: [...state.custom.filter(x => !ps.some(p => p.id === x.id)), ...ps.map(p => ({ ...p, builtIn: undefined }))] }),
  selectTerminal: (id: string) => commit({ ...state, terminalSelected: id }),
  addTerminal: (t: TerminalPalette) => commit({ ...state, terminalCustom: [...state.terminalCustom.filter(x => x.id !== t.id), t], terminalSelected: t.id }),
  removeTerminal: (id: string) => commit({ ...state, terminalCustom: state.terminalCustom.filter(x => x.id !== id), terminalSelected: state.terminalSelected === id ? 'dmcr' : state.terminalSelected }),
  setTerminalHidden: (id: string, hidden: boolean) => commit({ ...state, terminalHidden: hidden ? [...new Set([...state.terminalHidden, id])] : state.terminalHidden.filter(h => h !== id) }),
  importTerminal: (ts: TerminalPalette[]) => commit({ ...state, terminalCustom: [...state.terminalCustom.filter(x => !ts.some(t => t.id === x.id)), ...ts] }),
};

export function useThemeState(): ThemeState {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => state);
}
export function currentMode(): 'dark' | 'light' { return mode; }
