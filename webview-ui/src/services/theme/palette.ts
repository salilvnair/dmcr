/**
 * DMCR colour palettes, the same model as Daakia's: a palette answers thirteen questions (seeds),
 * once for dark and once for light, and everything the stylesheet uses is derived from them.
 * Mode (dark / light / system) stays a separate choice; a palette only decides the colours.
 *
 * The built-ins are Daakia's palettes (Tokyo Night, Gruvbox, Nord, Rosé Pine), Catppuccin, Dracula, Kanagawa,
 * Everforest and GitHub (each from its published dark and light palette), plus DMCR's own, which is
 * "no palette": the stylesheet as it ships.
 */
import { mix, alpha, isDarkColour, flipForOtherGround, shiftLightness } from './colour';
import { tokenValues, type Family } from './tokens';

export interface AppSeeds {
  /** Top bar, sidebars, the ground everything sits on. */
  ground: string;
  /** Cards, editors, modals. */
  surface: string;
  border: string;
  text: string;
  muted: string;
  inputBg: string;
  inputBorder: string;
  inputText: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  info: string;
}

export interface AppPalette {
  id: string;
  label: string;
  /** The colour that stands for this palette in the picker. */
  swatch: string;
  dark: AppSeeds;
  light: AppSeeds;
  /** The light half was computed from the dark one, not authored. */
  lightDerived?: boolean;
  /** Optional identity colours (violet, pink, orange, teal, lime); absent keeps DMCR's own. */
  identity?: Partial<Record<Family, string>>;
  /** Escape hatch: any --variable by name, applied last. */
  overrides?: Record<string, string>;
  builtIn?: boolean;
}

export const SEED_KEYS: (keyof AppSeeds)[] = [
  'ground', 'surface', 'border', 'text', 'muted', 'inputBg', 'inputBorder', 'inputText',
  'accent', 'success', 'warning', 'error', 'info',
];

/** What each seed is called and what it reaches, for the theme builder. */
export const SEED_META: Record<keyof AppSeeds, { label: string; reaches: string }> = {
  ground: { label: 'Ground', reaches: 'Top bar, sidebars, the page behind everything' },
  surface: { label: 'Surface', reaches: 'Cards, editors, modals, and their hover shades' },
  border: { label: 'Border', reaches: 'Every divider, outline and separator' },
  text: { label: 'Text', reaches: 'Body text, and every grey between it and the ground' },
  muted: { label: 'Muted', reaches: 'Captions, placeholders, disabled labels' },
  inputBg: { label: 'Field', reaches: 'The inside of every text field and dropdown' },
  inputBorder: { label: 'Field border', reaches: 'The outline of every field' },
  inputText: { label: 'Field text', reaches: 'What you type' },
  accent: { label: 'Accent', reaches: 'Primary buttons, selection, focus, every indigo shade' },
  success: { label: 'Success', reaches: 'Applied, passed, deploy succeeded, every green' },
  warning: { label: 'Warning', reaches: 'Pending, drift, conflicts, every amber' },
  error: { label: 'Error', reaches: 'Failed, blocked, danger_, every red' },
  info: { label: 'Info', reaches: 'Notices, links, every blue and sky' },
};

/** DMCR as it ships, restated as seeds (for the picker preview; applying it clears the palette). */
const DMCR_DARK: AppSeeds = {
  ground: '#141414', surface: '#1e1e1e', border: '#2a2a2a',
  text: '#e5e7eb', muted: '#64748b',
  inputBg: '#232323', inputBorder: '#333333', inputText: '#e2e8f0',
  accent: '#6366f1', success: '#22c55e', warning: '#f59e0b', error: '#ef4444', info: '#3b82f6',
};
const DMCR_LIGHT: AppSeeds = {
  ground: '#f1f5f9', surface: '#ffffff', border: '#e2e8f0',
  text: '#1e293b', muted: '#94a3b8',
  inputBg: '#ffffff', inputBorder: '#cbd5e1', inputText: '#1e293b',
  accent: '#4f46e5', success: '#16a34a', warning: '#d97706', error: '#dc2626', info: '#2563eb',
};

export const DEFAULT_PALETTE_ID = 'dmcr';

export const BUILT_IN_PALETTES: AppPalette[] = [
  { id: DEFAULT_PALETTE_ID, label: 'DMCR', swatch: '#6366f1', dark: DMCR_DARK, light: DMCR_LIGHT, builtIn: true },
  {
    id: 'tokyo', label: 'Tokyo Night', swatch: '#7aa2f7', builtIn: true,
    dark: {
      ground: '#16161e', surface: '#1a1b26', border: '#2f3549', text: '#a9b1d6', muted: '#565f89',
      inputBg: '#1f2335', inputBorder: '#343b58', inputText: '#a9b1d6',
      accent: '#7aa2f7', success: '#9ece6a', warning: '#e0af68', error: '#f7768e', info: '#7dcfff',
    },
    light: {
      ground: '#e6e7ed', surface: '#f2f3f7', border: '#c4c8da', text: '#343b58', muted: '#6c7394',
      inputBg: '#ffffff', inputBorder: '#c4c8da', inputText: '#343b58',
      accent: '#2e5ec9', success: '#4a7a22', warning: '#8f6424', error: '#b4263f', info: '#1c7c9e',
    },
  },
  {
    id: 'gruvbox', label: 'Gruvbox', swatch: '#fabd2f', builtIn: true,
    dark: {
      ground: '#1d2021', surface: '#282828', border: '#504945', text: '#ebdbb2', muted: '#928374',
      inputBg: '#32302f', inputBorder: '#504945', inputText: '#ebdbb2',
      accent: '#fabd2f', success: '#b8bb26', warning: '#fe8019', error: '#fb4934', info: '#83a598',
    },
    light: {
      ground: '#f2e5bc', surface: '#fbf1c7', border: '#d5c4a1', text: '#3c3836', muted: '#7c6f64',
      inputBg: '#fbf1c7', inputBorder: '#d5c4a1', inputText: '#3c3836',
      accent: '#b57614', success: '#79740e', warning: '#af3a03', error: '#9d0006', info: '#076678',
    },
  },
  {
    id: 'nord', label: 'Nord', swatch: '#88c0d0', builtIn: true,
    dark: {
      ground: '#2e3440', surface: '#3b4252', border: '#4c566a', text: '#eceff4', muted: '#7b88a1',
      inputBg: '#434c5e', inputBorder: '#4c566a', inputText: '#eceff4',
      accent: '#88c0d0', success: '#a3be8c', warning: '#ebcb8b', error: '#bf616a', info: '#81a1c1',
    },
    light: {
      ground: '#e5e9f0', surface: '#eceff4', border: '#c2ccdb', text: '#2e3440', muted: '#5c6a83',
      inputBg: '#ffffff', inputBorder: '#c2ccdb', inputText: '#2e3440',
      accent: '#2f7c96', success: '#4f7a3a', warning: '#996b1f', error: '#a3454e', info: '#3c6491',
    },
  },
  {
    id: 'rose', label: 'Rosé Pine', swatch: '#c4a7e7', builtIn: true,
    dark: {
      ground: '#191724', surface: '#1f1d2e', border: '#403d52', text: '#e0def4', muted: '#6e6a86',
      inputBg: '#26233a', inputBorder: '#403d52', inputText: '#e0def4',
      accent: '#c4a7e7', success: '#9ccfd8', warning: '#f6c177', error: '#eb6f92', info: '#31748f',
    },
    light: {
      ground: '#faf4ed', surface: '#fffaf3', border: '#dfd9d2', text: '#575279', muted: '#797593',
      inputBg: '#fffaf3', inputBorder: '#dfd9d2', inputText: '#575279',
      accent: '#907aa9', success: '#286983', warning: '#ea9d34', error: '#b4637a', info: '#56949f',
    },
  },
  // ── From each theme's published palette: Catppuccin Mocha / Latte (catppuccin/palette), Dracula / Alucard
  //    (spec.draculatheme.com), Kanagawa Wave / Lotus (kanagawa.nvim colors.lua), Everforest dark / light medium
  //    (sainnhe/everforest palette.md), GitHub dark / light (Primer primitives) ──
  {
    id: 'catppuccin', label: 'Catppuccin', swatch: '#cba6f7', builtIn: true,
    dark: {
      ground: '#181825', surface: '#1e1e2e', border: '#313244', text: '#cdd6f4', muted: '#7f849c',
      inputBg: '#313244', inputBorder: '#45475a', inputText: '#cdd6f4',
      accent: '#cba6f7', success: '#a6e3a1', warning: '#fab387', error: '#f38ba8', info: '#89b4fa',
    },
    light: {
      ground: '#e6e9ef', surface: '#eff1f5', border: '#ccd0da', text: '#4c4f69', muted: '#6c6f85',
      inputBg: '#eff1f5', inputBorder: '#bcc0cc', inputText: '#4c4f69',
      accent: '#8839ef', success: '#40a02b', warning: '#fe640b', error: '#d20f39', info: '#1e66f5',
    },
  },
  {
    id: 'dracula', label: 'Dracula', swatch: '#bd93f9', builtIn: true,
    dark: {
      ground: '#21222c', surface: '#282a36', border: '#44475a', text: '#f8f8f2', muted: '#6272a4',
      inputBg: '#21222c', inputBorder: '#44475a', inputText: '#f8f8f2',
      accent: '#bd93f9', success: '#50fa7b', warning: '#ffb86c', error: '#ff5555', info: '#8be9fd',
    },
    light: {
      ground: '#efeddc', surface: '#fffbeb', border: '#cfcfde', text: '#1f1f1f', muted: '#6c664b',
      inputBg: '#fffbeb', inputBorder: '#cfcfde', inputText: '#1f1f1f',
      accent: '#644ac9', success: '#14710a', warning: '#a34d14', error: '#cb3a2a', info: '#036a96',
    },
  },
  {
    id: 'kanagawa', label: 'Kanagawa', swatch: '#7e9cd8', builtIn: true,
    dark: {
      ground: '#16161d', surface: '#1f1f28', border: '#363646', text: '#dcd7ba', muted: '#727169',
      inputBg: '#2a2a37', inputBorder: '#54546d', inputText: '#dcd7ba',
      accent: '#7e9cd8', success: '#98bb6c', warning: '#e6c384', error: '#e46876', info: '#7fb4ca',
    },
    light: {
      ground: '#e5ddb0', surface: '#f2ecbc', border: '#d5cea3', text: '#545464', muted: '#8a8980',
      inputBg: '#f2ecbc', inputBorder: '#d5cea3', inputText: '#545464',
      accent: '#4d699b', success: '#6f894e', warning: '#cc6d00', error: '#c84053', info: '#4e8ca2',
    },
  },
  {
    id: 'everforest', label: 'Everforest', swatch: '#a7c080', builtIn: true,
    dark: {
      ground: '#232a2e', surface: '#2d353b', border: '#475258', text: '#d3c6aa', muted: '#859289',
      inputBg: '#343f44', inputBorder: '#4f585e', inputText: '#d3c6aa',
      accent: '#a7c080', success: '#83c092', warning: '#dbbc7f', error: '#e67e80', info: '#7fbbb3',
    },
    light: {
      ground: '#efebd4', surface: '#fdf6e3', border: '#e0dcc7', text: '#5c6a72', muted: '#939f91',
      inputBg: '#f4f0d9', inputBorder: '#bdc3af', inputText: '#5c6a72',
      accent: '#8da101', success: '#35a77c', warning: '#f57d26', error: '#f85552', info: '#3a94c5',
    },
  },
  {
    id: 'github', label: 'GitHub', swatch: '#4493f8', builtIn: true,
    dark: {
      ground: '#010409', surface: '#0d1117', border: '#3d444d', text: '#f0f6fc', muted: '#9198a1',
      inputBg: '#212830', inputBorder: '#3d444d', inputText: '#f0f6fc',
      accent: '#4493f8', success: '#3fb950', warning: '#d29922', error: '#f85149', info: '#ab7df8',
    },
    light: {
      ground: '#f6f8fa', surface: '#ffffff', border: '#d1d9e0', text: '#1f2328', muted: '#59636e',
      inputBg: '#f6f8fa', inputBorder: '#d1d9e0', inputText: '#1f2328',
      accent: '#0969da', success: '#1a7f37', warning: '#9a6700', error: '#d1242f', info: '#8250df',
    },
  },
];


/** The variables a palette sets in DMCR's stylesheet (and the --color-* names dui reads). */
export function cssVariables(seeds: AppSeeds): Record<string, string> {
  const { ground, surface, border, text, muted, accent } = seeds;
  const onDark = isDarkColour(ground);
  // "slightly raised": towards the text colour on a dark ground, away from it on a light one
  const lift = (base: string, amount: number) => mix(text, base, onDark ? amount : amount * 0.55);
  const secondary = mix(text, muted, 0.55);

  return {
    // grounds and surfaces
    '--bg-primary': ground,
    '--bg-secondary': mix(text, ground, 0.03),
    '--bs-toolbar-bg': mix('#000000', ground, onDark ? 0.15 : 0.03),
    '--ce-surface': surface,
    '--ce-border': border,
    '--bs-editor-bg': lift(surface, 0.03),
    '--color-surface': surface,
    '--color-surface-bg': surface,
    '--color-surface-hover': lift(surface, 0.06),
    '--color-surface-active': lift(surface, 0.11),
    '--color-surface-border': border,
    '--bs-row-hover-bg': lift(surface, 0.03),
    '--bs-info-bg': lift(surface, 0.04),
    '--bs-info-color': secondary,
    // text
    '--text-primary': text,
    '--text-secondary': secondary,
    '--color-text-primary': text,
    '--color-text-secondary': secondary,
    '--color-text-muted': muted,
    // inputs and dropdowns
    '--bs-input-bg': seeds.inputBg,
    '--bs-input-border': seeds.inputBorder,
    '--bs-input-color': seeds.inputText,
    '--bs-input-hover-bg': lift(seeds.inputBg, 0.05),
    '--bs-input-hover-border': mix(text, seeds.inputBorder, 0.25),
    '--bs-input-focus-bg': seeds.inputBg,
    '--bs-input-placeholder': muted,
    '--bs-dropdown-menu-bg': lift(surface, 0.05),
    '--bs-dropdown-menu-border': border,
    '--bs-dropdown-option-color': secondary,
    '--bs-dropdown-hover-bg': alpha(accent, 0.1),
    // accent
    '--bs-accent': accent,
    '--bs-accent-soft': mix(accent, text, 0.6),
    '--bs-accent-muted': mix(accent, text, 0.8),
    '--bs-accent-ring': alpha(accent, 0.15),
    '--bs-accent-bg': alpha(accent, 0.1),
    '--bs-accent-bg-hover': alpha(accent, 0.18),
    '--bs-btn-primary-bg': accent,
    '--bs-btn-primary-hover': mix(accent, ground, 0.85),
    '--color-accent': accent,
    // status
    '--bs-status-success': seeds.success,
    '--bs-status-warn': seeds.warning,
    '--bs-status-error': seeds.error,
    '--bs-status-info': seeds.info,
  };
}

/** The palette's block for one mode: every colour token, then the named variables, then overrides.
 *  Written for :root and for any [data-theme] element (DMCR sets data-theme on its root div). */
export function paletteCss(palette: AppPalette, mode: 'dark' | 'light'): string {
  const seeds = mode === 'dark' ? palette.dark : palette.light;
  const vars: Record<string, string> = { ...tokenValues(seeds, palette.identity), ...cssVariables(seeds) };
  for (const [name, value] of Object.entries(palette.overrides ?? {})) {
    if (/^--[\w-]+$/.test(name)) vars[name] = value;
  }
  const body = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `:root, [data-theme] {\n${body}\n}`;
}

/** A light half for a palette that only has a dark one (Daakia's rule: legible, not designed). */
export function deriveLightSeeds(dark: AppSeeds): AppSeeds {
  const paper = (hex: string, l: number) => shiftLightness(hex, l, 0.22);
  const ink = (hex: string) => flipForOtherGround(hex, true);
  const surface = paper(dark.surface, 0.985);
  const text = ink(dark.text);
  return {
    ground: paper(dark.surface, 0.94), surface, border: paper(dark.border, 0.82), text,
    muted: mix(text, surface, 0.52), inputBg: paper(dark.inputBg, 0.995), inputBorder: paper(dark.inputBorder, 0.84), inputText: text,
    accent: ink(dark.accent), success: ink(dark.success), warning: ink(dark.warning), error: ink(dark.error), info: ink(dark.info),
  };
}
