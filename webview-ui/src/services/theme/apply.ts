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
/**
 * Terminal themes for the palettes dui does not ship one for, from each theme's published terminal colours:
 * Dracula / Alucard (spec.draculatheme.com), Kanagawa (kanagawa.nvim extras/kitty), GitHub (github-theme-contrib
 * kitty); Everforest's slots are its palette.md colours.
 */
const EXTRA_TERMINALS: TerminalPalette[] = [
  {
    id: 'dracula', label: 'Dracula', swatch: '#bd93f9',
    dark: {
      foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    light: {
      foreground: '#1f1f1f', cursor: '#1f1f1f', selectionBackground: '#cfcfde',
      black: '#1f1f1f', red: '#cb3a2a', green: '#14710a', yellow: '#846e15', blue: '#644ac9', magenta: '#a3144d', cyan: '#036a96', white: '#6c664b',
      brightBlack: '#6c664b', brightRed: '#cb3a2a', brightGreen: '#14710a', brightYellow: '#846e15', brightBlue: '#644ac9', brightMagenta: '#a3144d', brightCyan: '#036a96', brightWhite: '#1f1f1f',
    },
  },
  {
    id: 'kanagawa', label: 'Kanagawa', swatch: '#7e9cd8',
    dark: {
      foreground: '#dcd7ba', cursor: '#c8c093', selectionBackground: '#2d4f67',
      black: '#16161d', red: '#c34043', green: '#76946a', yellow: '#c0a36e', blue: '#7e9cd8', magenta: '#957fb8', cyan: '#6a9589', white: '#c8c093',
      brightBlack: '#727169', brightRed: '#e82424', brightGreen: '#98bb6c', brightYellow: '#e6c384', brightBlue: '#7fb4ca', brightMagenta: '#938aa9', brightCyan: '#7aa89f', brightWhite: '#dcd7ba',
    },
    light: {
      foreground: '#545464', cursor: '#43436c', selectionBackground: '#c9cbd1',
      black: '#1f1f28', red: '#c84053', green: '#6f894e', yellow: '#77713f', blue: '#4d699b', magenta: '#b35b79', cyan: '#597b75', white: '#545464',
      brightBlack: '#8a8980', brightRed: '#d7474b', brightGreen: '#6e915f', brightYellow: '#836f4a', brightBlue: '#6693bf', brightMagenta: '#624c83', brightCyan: '#5e857a', brightWhite: '#43436c',
    },
  },
  {
    id: 'everforest', label: 'Everforest', swatch: '#a7c080',
    dark: {
      foreground: '#d3c6aa', cursor: '#d3c6aa', selectionBackground: 'rgba(167,192,128,.25)',
      black: '#475258', red: '#e67e80', green: '#a7c080', yellow: '#dbbc7f', blue: '#7fbbb3', magenta: '#d699b6', cyan: '#83c092', white: '#d3c6aa',
      brightBlack: '#859289', brightRed: '#e67e80', brightGreen: '#a7c080', brightYellow: '#dbbc7f', brightBlue: '#7fbbb3', brightMagenta: '#d699b6', brightCyan: '#83c092', brightWhite: '#9da9a0',
    },
    light: {
      foreground: '#5c6a72', cursor: '#5c6a72', selectionBackground: 'rgba(141,161,1,.18)',
      black: '#5c6a72', red: '#f85552', green: '#8da101', yellow: '#dfa000', blue: '#3a94c5', magenta: '#df69ba', cyan: '#35a77c', white: '#939f91',
      brightBlack: '#829181', brightRed: '#f85552', brightGreen: '#8da101', brightYellow: '#dfa000', brightBlue: '#3a94c5', brightMagenta: '#df69ba', brightCyan: '#35a77c', brightWhite: '#a6b0a0',
    },
  },
  {
    id: 'github', label: 'GitHub', swatch: '#4493f8',
    dark: {
      foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: 'rgba(68,147,248,.3)',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff',
    },
    light: {
      foreground: '#1f2328', cursor: '#1f2328', selectionBackground: 'rgba(9,105,218,.18)',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
  },
];
export const BUILT_IN_TERMINALS: TerminalPalette[] = [DMCR_TERMINAL, ...TERMINAL_PALETTES, ...EXTRA_TERMINALS];

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
  const { colours, ground } = terminalColours(currentTerminal(), p, mode);
  styleEl('dmcr-terminal').textContent = `:root, [data-theme] {\n${Object.entries(colours).map(([k, v]) => `  --dm-term-${k}: ${v};`).join('\n')}\n  --dm-term-background: ${ground};\n}`;
}

/**
 * A terminal theme's colours as the Runner shows them: on the app's terminal surface (--dm-c-0d1117 / f8fafc),
 * recomputed by the palette. The Theme settings preview uses this too, so it matches the Runner exactly.
 */
export function terminalColours(term: TerminalPalette, palette: AppPalette, m: 'dark' | 'light' = mode): { colours: Record<string, string>; ground: string } {
  const seeds = m === 'dark' ? palette.dark : palette.light;
  const ground = palette.id === DEFAULT_PALETTE_ID ? (m === 'dark' ? '#0d1117' : '#f8fafc') : (tokenValues(seeds)[m === 'dark' ? '--dm-c-0d1117' : '--dm-c-f8fafc'] ?? seeds.surface);
  return { colours: resolveTerminalTheme(term, m, ground) as unknown as Record<string, string>, ground };
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
