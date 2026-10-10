import AnsiToHtml from 'ansi-to-html';

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
  0:  'var(--dm-term-black)',
  1:  'var(--dm-term-red)',
  2:  'var(--dm-term-green)',
  3:  'var(--dm-term-yellow)',
  4:  'var(--dm-term-blue)',         // CI → #818cf8
  5:  'var(--dm-term-magenta)',      // CM → #c084fc
  6:  'var(--dm-term-cyan)',         // CC → #67e8f9
  7:  'var(--dm-term-white)',        // CB → #e2e8f0
  8:  'var(--dm-term-brightBlack)',  // CD → #334155
  9:  'var(--dm-term-brightRed)',
  10: 'var(--dm-term-brightGreen)',
  11: 'var(--dm-term-brightYellow)',
  12: 'var(--dm-term-brightBlue)',
  13: 'var(--dm-term-brightMagenta)',
  14: 'var(--dm-term-brightCyan)',
  15: 'var(--dm-term-brightWhite)',
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
      fg:        'var(--dm-term-foreground)',
      bg:        'var(--dm-term-background)',
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
