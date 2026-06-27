import AnsiToHtml from 'ansi-to-html';
import { XTERM_THEME } from './themes';

export interface OutputLine {
  id:    number;
  html:  string;
  runId?: number;
}

export type RunStatus = 'running' | 'done' | 'error';

export interface RunBlock {
  id:           number;
  label:        string;
  status:       RunStatus;
  startedAt:    number;
  endedAt?:     number;
  startLineIdx: number;
  endLineIdx?:  number;
}

type UpdateCb = (lines: OutputLine[], currentLine: OutputLine | null, blocks: RunBlock[]) => void;

// 16-color palette matching the xterm dark theme exactly
const ANSI_COLORS: Record<number, string> = {
  0:  XTERM_THEME.black,
  1:  XTERM_THEME.red,
  2:  XTERM_THEME.green,
  3:  XTERM_THEME.yellow,
  4:  XTERM_THEME.blue,         // CI → #818cf8
  5:  XTERM_THEME.magenta,      // CM → #c084fc
  6:  XTERM_THEME.cyan,         // CC → #67e8f9
  7:  XTERM_THEME.white,        // CB → #e2e8f0
  8:  XTERM_THEME.brightBlack,  // CD → #334155
  9:  XTERM_THEME.brightRed,
  10: XTERM_THEME.brightGreen,
  11: XTERM_THEME.brightYellow,
  12: XTERM_THEME.brightBlue,
  13: XTERM_THEME.brightMagenta,
  14: XTERM_THEME.brightCyan,
  15: XTERM_THEME.brightWhite,
};

export class VirtualTerm {
  private _lines:          OutputLine[] = [];
  private _current         = '';
  private _id              = 0;
  private _cb:             UpdateCb | null = null;
  private _conv:           AnsiToHtml;

  private _blocks:         RunBlock[] = [];
  private _blockId         = 0;
  private _currentBlockId  = -1;

  cols = 100;

  constructor() {
    this._conv = new AnsiToHtml({
      fg:        XTERM_THEME.foreground,
      bg:        XTERM_THEME.background,
      escapeXML: true,
      colors:    ANSI_COLORS,
    });
  }

  onUpdate(cb: UpdateCb) { this._cb = cb; }

  // ── Run block lifecycle ─────────────────────────────────────────────────────
  startBlock(label: string): number {
    if (this._current) { this._commit(this._current); this._current = ''; }
    const id = this._blockId++;
    this._blocks.push({ id, label, status: 'running', startedAt: Date.now(), startLineIdx: this._lines.length });
    this._currentBlockId = id;
    this._notify();
    return id;
  }

  endBlock(status: RunStatus): void {
    if (this._currentBlockId < 0) return;
    if (this._current) { this._commit(this._current); this._current = ''; }
    const block = this._blocks.find(b => b.id === this._currentBlockId);
    if (block) {
      block.status    = status;
      block.endedAt   = Date.now();
      block.endLineIdx = this._lines.length;
    }
    this._currentBlockId = -1;
    this._notify();
  }

  getBlocks(): RunBlock[] { return this._blocks; }

  // ── Write API ───────────────────────────────────────────────────────────────
  write(data: string): void {
    // Normalize \r\n → \n (extension converts \n to \r\n for terminal compat)
    data = data.replace(/\r\n/g, '\n');

    // \r\x1b[2K = erase current line (used by spinners)
    const hasErase = /\r\x1b\[2K/.test(data);
    if (hasErase) {
      this._current = '';
      data = data.replace(/\r\x1b\[2K/g, '');
      if (!data) { this._notify(); return; }
    }

    // Strip cursor-move CSI sequences (not color codes)
    data = data.replace(/\x1b\[[\d;]*[ABCDEFGHJKSTfnsuhl]/g, (seq) =>
      /\x1b\[2K/.test(seq) ? '' : ''
    );

    const chunks = data.split('\n');
    for (let i = 0; i < chunks.length; i++) {
      let chunk = chunks[i];
      if (chunk.includes('\r')) {
        const parts = chunk.split('\r');
        chunk = parts[parts.length - 1] ?? '';
        this._current = chunk;
      } else {
        this._current += chunk;
      }
      if (i < chunks.length - 1) { this._commit(this._current); this._current = ''; }
    }
    this._notify();
  }

  writeln(data: string): void { this.write(data + '\n'); }

  clear(): void {
    this._lines          = [];
    this._current        = '';
    this._blocks         = [];
    this._currentBlockId = -1;
    this._notify();
  }

  // ── Accessors ───────────────────────────────────────────────────────────────
  getLines(): OutputLine[] { return this._lines; }

  getCurrentLine(): OutputLine | null {
    if (!this._current) return null;
    return { id: -1, html: this._toHtml(this._current) };
  }

  scrollToBottom(): void { /* React side handles */ }
  focus():          void { /* React side handles */ }

  // Legacy compat for copy-output
  get buffer() {
    const lines = this._lines;
    return {
      active: {
        length:  lines.length,
        getLine: (i: number) => lines[i]
          ? { translateToString: (_trim: boolean) => lines[i].html.replace(/<[^>]*>/g, '') }
          : null,
      },
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────
  private _commit(raw: string): void {
    const html  = this._toHtml(raw);
    const runId = this._currentBlockId >= 0 ? this._currentBlockId : undefined;
    this._lines.push({ id: this._id++, html, runId });
  }

  private _toHtml(raw: string): string {
    if (!raw) return '';
    try {
      return this._conv.toHtml(raw);
    } catch {
      return raw
        .replace(/\x1b\[[\d;]*m/g, '')
        .replace(/[<>&"]/g, c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;');
    }
  }

  private _notify(): void {
    this._cb?.([...this._lines], this.getCurrentLine(), this._blocks.map(b => ({ ...b })));
  }
}
