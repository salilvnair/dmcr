import { CI, CB, CD, CG, CR, CY, CC, CM, RST, BOLD, DIM, padToW } from './ansi';
import { CMD_HELP_DOCS } from './help-docs';

// Minimal interface — no xterm dependency required
export interface TermLike {
  write:   (data: string) => void;
  writeln: (data: string) => void;
  cols:    number;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────
export const PROMPT_STR      = `\r\n${CI}❯${RST} ${CB}dmcr${RST} ${CI}›${RST} `;
export const PROMPT_STR_INIT = `${CI}❯${RST} ${CB}dmcr${RST} ${CI}›${RST} `;

// Prompt is now a persistent React element — this is a no-op kept for API compat
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function writePrompt(_term: TermLike, _initial = false) { }

// ─── Shared unknown-command error box ────────────────────────────────────────
export function printUnknown(term: TermLike, input: string) {
  const display = input.length > 40 ? input.slice(0, 37) + '…' : input;
  const line1Vis = 4 + 'Unknown: '.length + display.length;
  const line3Vis = 2 + 'Type /help to see all available commands'.length;
  const W = Math.max(48, line1Vis + 2, line3Vis + 2);
  const c1 = `  ${CR}✗  Unknown: ${CC}${display}${RST}`;
  const c2 = `  ${CD}Not a valid DMCR command${RST}`;
  const c3 = `  ${CD}Type ${CI}/help${CD} to see all available commands${RST}`;
  term.writeln('');
  term.writeln(`  ${CY}╭${'─'.repeat(W)}╮${RST}`);
  term.writeln(`  ${CY}│${RST}${padToW(c1, W)}${CY}│${RST}`);
  term.writeln(`  ${CY}│${RST}${padToW(c2, W)}${CY}│${RST}`);
  term.writeln(`  ${CY}│${RST}${' '.repeat(W)}${CY}│${RST}`);
  term.writeln(`  ${CY}│${RST}${padToW(c3, W)}${CY}│${RST}`);
  term.writeln(`  ${CY}╰${'─'.repeat(W)}╯${RST}`);
}

// ─── DMCR ASCII logo (ANSI Shadow font) ──────────────────────────────────────
export const LOGO_LINES = [
  `${CI}  ██████╗  ███╗   ███╗  ██████╗  ██████╗  ${RST}`,
  `${CI}  ██╔══██╗ ████╗ ████║ ██╔════╝  ██╔══██╗ ${RST}`,
  `${CI}  ██║  ██║ ██╔████╔██║ ██║       ██████╔╝ ${RST}`,
  `${CI}  ██║  ██║ ██║╚██╔╝██║ ██║       ██╔══██╗ ${RST}`,
  `${CI}  ██████╔╝ ██║ ╚═╝ ██║ ╚██████╗  ██║  ██║ ${RST}`,
  `${CI}  ╚═════╝  ╚═╝     ╚═╝  ╚═════╝  ╚═╝  ╚═╝ ${RST}`,
];

export function printLogo(term: TermLike) {
  const P = '                    ';
  term.writeln('');
  for (const line of LOGO_LINES) {
    term.writeln(P + line);
  }
  term.writeln('');
  term.writeln(`${P}${CB}  Database Management & Change Request Tracker for PostgreSQL${RST}`);
  term.writeln(`${P}${CD}  v1.1.0  ·  VS Code Extension  ·  type ${CI}/help${CD} for commands${RST}`);
  term.writeln('');
}

// ─── /help command output ────────────────────────────────────────────────────
export function printHelp(term: TermLike) {
  const rows: [string, string][] = [
    ['/status',            'Show applied / pending changes'],
    ['/deploy',            'Apply all pending changes'],
    ['/deploy --dry-run',  'Preview pending changes (prints SQL, no DB writes)'],
    ['/deploy --to <id>',  'Deploy up to a specific change or @tag'],
    ['/verify',            'Run verify.sql for last change'],
    ['/history',           'Show change_log history'],
    ['/info',              'Summary stats and registry health'],
    ['/plan',              'Show dependency-aware execution plan'],
    ['/check',             'Preflight validation (no DB writes)'],
    ['/parse <sql>',       'Validate SQL inside a rolled-back transaction'],
    ['/repeatable',        'Apply all R__ migrations with changed checksums'],
    ['/tag list',          'List release tags'],
    ['/tag create <name>', 'Create a release tag at current state'],
    ['/tag delete <name>', 'Delete a release tag'],
    ['/revertLast',        'Revert the last applied change'],
    ['/revert list',       'List all applied changes'],
    ['/revert <id>',       'Revert a specific change (must be latest)'],
    ['/revert to <id|@t>', 'Revert all changes down to target (or @tag)'],
    ['/baseline <id>',     'Mark change as applied without running SQL'],
    ['/repair --checksums','Recalculate all stored checksums'],
    ['/init',              'Initialize DMCR registry tables (once)'],
    ['/config',            'Show active configuration'],
    ['/ls [pattern]',      'Tree view of changes directory'],
    ['/it',                'Interactive revert mode (arrow keys)'],
  ];
  const rows2: [string, string][] = [
    ['/clear',        'Clear the terminal'],
    ['/help',         'Show this help'],
    ['\u2191 / \u2193', 'Navigate command history'],
  ];
  const maxRow = [...rows, ...rows2].reduce((mx, [l, h]) => Math.max(mx, 2 + l.length + 2 + h.length + 2), 0);
  const W = Math.max(60, maxRow);

  const row = (label: string, hint: string) => {
    const innerVis = 2 + label.length + 2 + hint.length;
    const spaces   = Math.max(0, W - innerVis);
    term.writeln(`${CI}\u2502${RST}  ${CC}${label}${RST}  ${CD}${hint}${RST}${' '.repeat(spaces)}${CI}\u2502${RST}`);
  };
  const blank  = () => term.writeln(`${CI}\u2502${RST}${' '.repeat(W)}${CI}\u2502${RST}`);

  const title  = 'DMCR  Commands';
  const tpad   = Math.floor((W - title.length) / 2);
  const titleL = ' '.repeat(tpad) + `${CB}${title}${RST}` + ' '.repeat(W - tpad - title.length);

  term.writeln(`${CI}\u256d${'─'.repeat(W)}\u256e${RST}`);
  term.writeln(`${CI}\u2502${RST}${titleL}${CI}\u2502${RST}`);
  blank();
  term.writeln(`${CI}\u251c${'─'.repeat(W)}\u2524${RST}`);
  rows.forEach(([l, h]) => row(l, h));
  blank();
  term.writeln(`${CI}\u251c${'─'.repeat(W)}\u2524${RST}`);
  rows2.forEach(([l, h]) => row(l, h));
  blank();
  term.writeln(`${CI}\u251c${'─'.repeat(W)}\u2524${RST}`);
  const tip = `  Tip: /<command> --help for detailed docs`;
  term.writeln(`${CI}\u2502${RST}${padToW(`  ${CM}${tip}${RST}`, W)}${CI}\u2502${RST}`);
  blank();
  term.writeln(`${CI}\u2570${'─'.repeat(W)}\u256f${RST}`);
  term.writeln('');
}

// ─── Per-command --help / -h output ──────────────────────────────────────────
export function printCommandHelp(term: TermLike, cmd: string) {
  const doc = CMD_HELP_DOCS[cmd.toLowerCase()];
  if (!doc) {
    term.writeln('');
    term.writeln(`  ${CR}\u2717${RST}  No help for ${CC}"${cmd}"${RST}`);
    term.writeln(`  ${CM}Type ${CI}/help${CM} for all commands${RST}`);
    term.writeln('');
    return;
  }

  const CP = '\x1b[38;5;183m'; // soft lavender for descriptions
  const W = Math.max(58, term.cols - 6);

  // Box helpers (same style as the command-output frame)
  const top = (label: string) => {
    const inner = 2 + label.length; // space + label + space
    const left = Math.max(1, Math.floor((W - inner) / 2));
    const right = Math.max(1, W - inner - left);
    term.writeln(`  ${CD}\u256d${'\u2500'.repeat(left)} ${CB}${label}${CD} ${'\u2500'.repeat(right)}\u256e${RST}`);
  };
  const row = (content: string) => term.writeln(`  ${CD}\u2502${RST}${padToW(` ${content}`, W)}${CD}\u2502${RST}`);
  const blank = () => term.writeln(`  ${CD}\u2502${RST}${' '.repeat(W)}${CD}\u2502${RST}`);
  const sep = () => term.writeln(`  ${CD}\u251c${'\u2500'.repeat(W)}\u2524${RST}`);
  const bot = () => term.writeln(`  ${CD}\u2570${'\u2500'.repeat(W)}\u256f${RST}`);

  term.writeln('');
  top(`/${doc.name} --help`);
  blank();
  row(`${BOLD}${CB}/${doc.name}${RST}  ${CD}${doc.emoji}${RST}`);
  row(`${CP}${doc.summary}${RST}`);
  blank();
  sep();

  // ─── Usage ───
  blank();
  row(`${BOLD}${CG}USAGE${RST}`);
  blank();
  for (const u of doc.usage) {
    row(`  ${CC}${u}${RST}`);
  }
  blank();

  // ─── Flags ───
  if (doc.flags && doc.flags.length > 0) {
    sep();
    blank();
    row(`${BOLD}${CG}FLAGS${RST}`);
    blank();
    for (const [flag, desc] of doc.flags) {
      row(`  ${CY}${BOLD}${flag}${RST}`);
      row(`    ${CP}${desc}${RST}`);
    }
    blank();
  }

  // ─── Examples ───
  sep();
  blank();
  row(`${BOLD}${CG}EXAMPLES${RST}`);
  blank();
  for (let i = 0; i < doc.examples.length; i++) {
    const [ex, desc] = doc.examples[i];
    row(`  ${CI}>${RST} ${BOLD}${CC}${ex}${RST}`);
    row(`    ${CP}${desc}${RST}`);
    if (i < doc.examples.length - 1) blank();
  }
  blank();

  // ─── Notes ───
  if (doc.notes && doc.notes.length > 0) {
    sep();
    blank();
    row(`${BOLD}${CG}NOTES${RST}`);
    blank();
    for (const note of doc.notes) {
      row(`  ${CM}*${RST} ${CP}${note}${RST}`);
    }
    blank();
  }

  // ─── Footer ───
  sep();
  row(`${CP}Type ${CI}/help${CP} for all commands  |  ${CI}/<cmd> --help${CP} for details${RST}`);
  bot();
  term.writeln('');
}
