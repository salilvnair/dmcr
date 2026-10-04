import { useEffect, useRef, useCallback, useState } from 'react';
import './RunnerPage.css';
import { postMsg } from '../../vscode';
import { useAiFeatures } from '../../utils/aiFeatures';
import { MarkdownView, ButtonView, ChipView, IconButtonView, ModalView, LoaderView } from '@salilvnair/dui';
import dmcrBotPng from '../../../../images/dmcr_bot.png';

import { CI, CB, CD, CG, CR, CY, CC, RST } from './ansi';
import { VALID_BARE, SLASH_CMDS, computeSuggestions, PRESETS, splitCommandArgs } from './commands';
import { writePrompt, printLogo, printCommandHelp, LOGO_LINES } from './printers';
import { VirtualTerm, type OutputLine, type RunBlock } from './VirtualTerm';
import type { TermLike } from './printers';
import { CommandResultView, type JsonCommandResult } from './views/CommandViews';

// ─── Public handle ────────────────────────────────────────────────────────────
export interface RunnerHandle {
  write:   (data: string) => void;
  writeln: (data: string) => void;
  clear:   () => void;
}

interface Props { onReady: (handle: RunnerHandle) => void; isDark?: boolean; }

// ─── Bot mascot ───────────────────────────────────────────────────────────────
function BotAsciiArt({ visible }: { visible: boolean }) {
  return (
    <img
      src={dmcrBotPng}
      alt="DMCR Bot"
      style={{
        position: 'absolute', top: 6, left: 14,
        width: 145, height: 'auto',
        pointerEvents: 'none', userSelect: 'none', zIndex: 100,
        opacity:   visible ? 1 : 0,
        filter:    visible ? 'none' : 'blur(4px)',
        animation: visible
          ? 'botAppear 0.55s cubic-bezier(0.34,1.56,0.64,1) both'
          : 'botDisappear 0.35s ease-in both',
      }}
    />
  );
}

// ─── /it Interactive Revert Overlay ──────────────────────────────────────────
interface ItOverlayProps {
  phase:     'select' | 'action';
  folders:   { name: string; files: string[] }[];
  sel:       number;
  actionSel: number;
  loading?:  boolean;
}

function ItOverlay({ phase, folders, sel, actionSel, loading }: ItOverlayProps) {
  // ── Loading skeleton while lsChanges is in-flight ──
  if (loading) {
    return (
      <div className="rp-it-overlay">
        <div className="rp-it-box rp-it-box--loading">
          <div className="rp-it-head-row">
            <span className="rp-it-head-title">Interactive Revert</span>
            <span className="rp-it-phase-chip rp-it-phase-chip--loading">Loading…</span>
          </div>
          <div className="rp-it-empty">
            <span className="rp-it-loading-dot" /><span className="rp-it-loading-dot" /><span className="rp-it-loading-dot" />
            <span className="rp-it-empty-text">Scanning changes directory…</span>
          </div>
          <div className="rp-it-foot">Esc  cancel</div>
        </div>
      </div>
    );
  }

  // ── Action phase ──
  if (phase === 'action' && folders[sel]) {
    const folder  = folders[sel];
    const actions = [
      { label: 'Revert this change',         hint: `revert ${folder.name}` },
      { label: 'Revert everything until this', hint: `revert to ${folder.name}` },
    ];
    return (
      <div className="rp-it-overlay">
        <div className="rp-it-box">
          <div className="rp-it-head-row">
            <span className="rp-it-head-title">Interactive Revert</span>
            <span className="rp-it-phase-chip rp-it-phase-chip--action">Step 2 / 2</span>
          </div>
          <div className="rp-it-selected-row">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#818cf8', flexShrink: 0 }}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span className="rp-it-selected-name">{folder.name}</span>
            <span className="rp-it-selected-files">{folder.files.length} file{folder.files.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="rp-it-divider" />
          {actions.map((a, i) => (
            <div key={a.label} className={`rp-it-row${i === actionSel ? ' is-sel' : ''}`}>
              <span className="rp-it-marker">{i === actionSel ? '▶' : ' '}</span>
              <div className="rp-it-action-info">
                <span className="rp-it-name">{a.label}</span>
                <span className="rp-it-hint">dmcr {a.hint}</span>
              </div>
            </div>
          ))}
          <div className="rp-it-foot">
            <span>← / Esc  go back</span>
            <span style={{ marginLeft: 'auto' }}>⏎  run command</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Select phase ──
  const visCount = Math.min(8, folders.length);
  const startIdx = Math.max(0, Math.min(sel - Math.floor(visCount / 2), folders.length - visCount));

  return (
    <div className="rp-it-overlay">
      <div className="rp-it-box">
        <div className="rp-it-head-row">
          <span className="rp-it-head-title">Interactive Revert</span>
          <span className="rp-it-phase-chip">Step 1 / 2</span>
        </div>
        <div className="rp-it-info-row">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#64748b', flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>Select a change to revert, then choose the action</span>
        </div>
        {folders.length === 0 ? (
          <div className="rp-it-empty">
            <span className="rp-it-empty-icon">○</span>
            <span className="rp-it-empty-text">No revertable changes found</span>
          </div>
        ) : (
          <>
            {folders.slice(startIdx, startIdx + visCount).map((f, idx) => {
              const i = startIdx + idx;
              return (
                <div key={f.name} className={`rp-it-row${i === sel ? ' is-sel' : ''}`}>
                  <span className="rp-it-marker">{i === sel ? '▶' : ' '}</span>
                  <span className="rp-it-name">{f.name}</span>
                  <span className="rp-it-file-count">{f.files.length}f</span>
                </div>
              );
            })}
            {folders.length > visCount && (
              <div className="rp-it-hint-row">… {folders.length - visCount} more  (↑↓ to scroll)</div>
            )}
          </>
        )}
        <div className="rp-it-foot">
          <span>↑↓  navigate</span>
          <span style={{ margin: '0 10px' }}>⏎  select</span>
          <span style={{ marginLeft: 'auto' }}>Esc  exit</span>
        </div>
      </div>
    </div>
  );
}

// ─── Risk score types ─────────────────────────────────────────────────────────
interface RiskScoreRow { change_id: string; risk: string; justification: string }
const RISK_COLOR: Record<string, string> = {
  LOW: '#4ade80', MEDIUM: '#fbbf24', HIGH: '#f97316', CRITICAL: '#f87171',
};

// ─── RunCard — styled card for each dmcr command execution ───────────────────
interface RunCardProps {
  block:            RunBlock;
  lines:            OutputLine[];
  currentLine:      OutputLine | undefined;
  collapsed:        boolean;
  onToggle:         () => void;
  jsonResult?:      JsonCommandResult;
  riskScores?:      RiskScoreRow[];
  isAnalyzingRisk?: boolean;
  onAnalyzeRisk?:   () => void;
}

function RunCard({ block, lines, currentLine, collapsed, onToggle, jsonResult, riskScores, isAnalyzingRisk, onAnalyzeRisk }: RunCardProps) {
  const elapsed = block.endedAt
    ? ((block.endedAt - block.startedAt) / 1000).toFixed(1)
    : null;
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = jsonResult
      ? JSON.stringify(jsonResult.data, null, 2)
      : block.label;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const [verb, ...rest] = block.label.split(' ');

  // Show JSON view when: not running AND a JSON result exists
  const showJsonView = block.status !== 'running' && jsonResult != null;

  // Show ANSI body when: collapsed=false AND (running OR has lines OR has currentLine)
  const hasAnsiContent = lines.length > 0 || currentLine != null || block.status === 'running';

  return (
    <div className={`rp-run-card rp-run-card--${block.status}`}>

      {/* ── Card header — clickable to collapse/expand ── */}
      <div className="rp-run-card-header" onClick={onToggle} style={{ cursor: 'pointer', userSelect: 'none' }}>
        <div className="rp-run-card-cmd">
          <span className={`rp-run-card-chevron${collapsed ? '' : ' rp-run-card-chevron--open'}`}>▶</span>
          <span className="rp-run-card-prefix">dmcr</span>
          <span className="rp-run-card-verb">{verb}</span>
          {rest.length > 0 && (
            <span className="rp-run-card-args">{rest.join(' ')}</span>
          )}
        </div>
        <div className="rp-run-card-meta">
          {elapsed && <span className="rp-run-card-elapsed">{elapsed}s</span>}
          <span className={`rp-run-badge rp-run-badge--${block.status}`}>
            {block.status === 'running' ? (
              <><span className="rp-run-badge-spin" />Running</>
            ) : block.status === 'done' ? (
              <>✓&nbsp;Done</>
            ) : (
              <>✗&nbsp;Failed</>
            )}
          </span>
          <button
            type="button"
            className={`rp-run-card-copy${copied ? ' rp-run-card-copy--copied' : ''}`}
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy result'}
          >
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* ── Card body — JSON view takes priority over ANSI lines when available ── */}
      {!collapsed && showJsonView && (
        <div className="rp-run-card-body">
          <CommandResultView result={jsonResult} />
          {/* D18.2 Risk Scorer — shown on dry-run results */}
          {jsonResult.command === 'deploy' && (jsonResult.data as Record<string,unknown>)?.['status'] === 'dry_run' && onAnalyzeRisk && (
            <div style={{ padding: '0 12px 10px 12px' }}>
              {!riskScores && (
                <button
                  style={{ fontSize: 10.5, padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.08)', color: '#818cf8', cursor: isAnalyzingRisk ? 'default' : 'pointer', fontFamily: 'sans-serif', opacity: isAnalyzingRisk ? 0.7 : 1 }}
                  disabled={isAnalyzingRisk}
                  onClick={onAnalyzeRisk}
                >{isAnalyzingRisk ? '✦ Analyzing…' : '✦ Analyze Risk'}</button>
              )}
              {riskScores && (
                <div style={{ marginTop: 6, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(99,102,241,0.18)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'rgba(99,102,241,0.1)', borderBottom: '1px solid rgba(99,102,241,0.15)' }}>
                    <span style={{ fontSize: 10, color: '#818cf8' }}>✦</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#818cf8', letterSpacing: 0.3 }}>AI Migration Risk Scorer</span>
                  </div>
                  <div style={{ background: 'rgba(99,102,241,0.04)' }}>
                    {riskScores.map(r => (
                      <div key={r.change_id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 11 }}>
                        <span style={{ fontFamily: 'monospace', color: '#94a3b8', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.change_id}>{r.change_id}</span>
                        <span style={{ flexShrink: 0, fontWeight: 700, fontSize: 10, padding: '1px 7px', borderRadius: 9999, background: `${RISK_COLOR[r.risk] ?? '#94a3b8'}22`, color: RISK_COLOR[r.risk] ?? '#94a3b8', border: `1px solid ${RISK_COLOR[r.risk] ?? '#94a3b8'}55`, letterSpacing: 0.5 }}>{r.risk}</span>
                        <span style={{ flexShrink: 0, color: '#64748b', fontSize: 10.5, maxWidth: 260, textAlign: 'right' }}>{r.justification}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {!collapsed && !showJsonView && hasAnsiContent && (
        <div className="rp-run-card-body">
          {lines.length === 0 && !currentLine && block.status === 'running' && (
            <div className="rp-run-card-loading">
              <LoaderView variant="dots" size="sm" accentColor="#a5b4fc" label="Waiting for output…" />
            </div>
          )}
          {lines.map(l => (
            <div
              key={l.id}
              className="rp-output-line"
              dangerouslySetInnerHTML={{ __html: l.html || '&nbsp;' }}
            />
          ))}
          {currentLine && (
            <div
              className="rp-output-line rp-output-line--current"
              dangerouslySetInnerHTML={{ __html: currentLine.html || '&nbsp;' }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Segment helpers ──────────────────────────────────────────────────────────
type Segment =
  | { type: 'static'; lines: OutputLine[]; currentLine?: OutputLine }
  | { type: 'run';    block: RunBlock;     lines: OutputLine[]; currentLine?: OutputLine };

function computeSegments(
  lines:       OutputLine[],
  currentLine: OutputLine | null,
  blocks:      RunBlock[],
): Segment[] {
  if (blocks.length === 0) {
    return [{ type: 'static', lines, currentLine: currentLine ?? undefined }];
  }

  const result: Segment[] = [];
  const emittedIds = new Set<number>();
  let pending: OutputLine[] = [];

  const flushPending = (cur?: OutputLine) => {
    if (pending.length > 0 || cur) {
      result.push({ type: 'static', lines: pending, currentLine: cur });
      pending = [];
    }
  };

  for (const line of lines) {
    if (line.runId === undefined) {
      pending.push(line);
    } else if (!emittedIds.has(line.runId)) {
      // First line of a new block — flush pending static, then emit the full block
      const block = blocks.find(b => b.id === line.runId);
      if (block) {
        flushPending();
        const blockLines = lines.filter(l => l.runId === block.id);
        const blockCur = block.status === 'running' ? (currentLine ?? undefined) : undefined;
        result.push({ type: 'run', block, lines: blockLines, currentLine: blockCur });
        emittedIds.add(block.id);
      } else {
        pending.push(line);
      }
    }
    // else: already emitted this block; skip (lines already included via filter)
  }

  const runningBlock = blocks.find(b => b.status === 'running');
  flushPending(runningBlock ? undefined : (currentLine ?? undefined));

  // Blocks that haven't appeared in lines yet (just started, no output)
  for (const block of blocks) {
    if (!emittedIds.has(block.id)) {
      const blockCur = block.status === 'running' ? (currentLine ?? undefined) : undefined;
      result.push({ type: 'run', block, lines: [], currentLine: blockCur });
    }
  }

  return result;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function RunnerPage({ onReady, isDark = true }: Props) {
  const isAiOn = useAiFeatures();
  const vtermRef      = useRef<VirtualTerm>(new VirtualTerm());
  const promptRef     = useRef<HTMLInputElement>(null);
  const outputRef     = useRef<HTMLDivElement>(null);

  const lineBufferRef    = useRef<string>('');
  const historyRef       = useRef<string[]>([]);
  const histIdxRef       = useRef<number>(-1);
  const runningRef       = useRef<boolean>(false);
  const scriptPathRef    = useRef<string>('');
  const acSelRef         = useRef<number>(0);
  const runningCmdRef    = useRef<string>('');
  const currentBlockIdRef = useRef<number>(-1);

  // /it interactive mode refs
  const itModeRef      = useRef<boolean>(false);
  const itFoldersRef   = useRef<{ name: string; files: string[] }[]>([]);
  const itSelRef       = useRef<number>(0);
  const itPhaseRef     = useRef<'select' | 'action'>('select');
  const itActionSelRef = useRef<number>(0);

  const [lines, setLines]           = useState<OutputLine[]>([]);
  const [currentLine, setCurrentLine] = useState<OutputLine | null>(null);
  const [blocks, setBlocks]         = useState<RunBlock[]>([]);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<number>>(new Set());
  const [jsonResults, setJsonResults] = useState<Map<number, JsonCommandResult>>(new Map());
  const [running, setRunning]       = useState(false);
  const [runningCmd, setRunningCmd] = useState('');
  const [lineBuffer, setLineBuffer] = useState('');
  const [acSel, setAcSel]           = useState(0);
  const [scriptPath, setScriptPath] = useState('');
  const [botVisible, setBotVisible] = useState(true);
  const [copied, setCopied]         = useState(false);
  const [itMode, setItMode]         = useState(false);
  const [itLoading, setItLoading]   = useState(false);
  const [itTick, setItTick]         = useState(0);
  const [gitBranch, setGitBranch]   = useState<string | null>(null);
  const [gitDirty, setGitDirty]     = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [runHistory, setRunHistory]   = useState<Array<{ id?: number; event_ts?: string; action: string; status: string; command?: string | null; exit_code?: number | null; duration_ms?: number | null }>>([]);
  const [explainId, setExplainId]     = useState<number | null>(null);
  const [explainText, setExplainText] = useState<Record<number, string>>({});
  const [riskScores, setRiskScores]     = useState<Map<number, RiskScoreRow[]>>(new Map());
  const [analyzingRisk, setAnalyzingRisk] = useState<Set<number>>(new Set());
  const [rollbackId, setRollbackId]       = useState<number | null>(null);
  const [rollbackText, setRollbackText]   = useState<Record<number, string>>({});
  const [generatingChangelog, setGeneratingChangelog] = useState(false);
  const [changelogMarkdown, setChangelogMarkdown] = useState<string | null>(null);
  const [showChangelogPopup, setShowChangelogPopup] = useState(false);
  const [showDeleteHistoryConfirm, setShowDeleteHistoryConfirm] = useState(false);
  // Gate (D19.1), Perf (D18.12) and the other per-change AI tools live on the /status change
  // list (views/ChangeAiTools.tsx): run rows only know the command line, not a change name.
  // AI result popup (replaces inline result divs)
  const [aiPopup, setAiPopup]             = useState<{ type: 'explain' | 'rollback'; rowId: number; cmd: string } | null>(null);
  const pendingExplainRef  = useRef<{ rowId: number; cmd: string } | null>(null);
  const pendingRollbackRef = useRef<{ rowId: number; cmd: string } | null>(null);
  // D19.10 — Ticket Linker
  const [linkingTickets, setLinkingTickets] = useState(false);
  const [ticketLinks, setTicketLinks]       = useState<{changeName:string;ticketId:string;ticketSystem:string;confidence:string;source:string}[] | null>(null);

  const suggestions = computeSuggestions(lineBuffer);
  const slashQuery  = lineBuffer.startsWith('/') ? lineBuffer.slice(1).trim() : '';
  const vterm       = vtermRef.current as unknown as TermLike;

  // ── Wire VirtualTerm → React state ─────────────────────────────────────────
  useEffect(() => {
    const vt = vtermRef.current;
    vt.onUpdate((ls, cur, blks) => {
      setLines([...ls]);
      setCurrentLine(cur);
      setBlocks([...blks]);
    });
    printLogo(vt as unknown as TermLike);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-scroll on new output ────────────────────────────────────────────
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, currentLine]);

  // ── Bot visibility based on scroll ───────────────────────────────────────
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    const logoH = LOGO_LINES.length * 20;
    const onScroll = () => setBotVisible(el.scrollTop <= logoH);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ── Scroll active suggestion into view ───────────────────────────────────
  useEffect(() => {
    if (suggestions.length === 0) return;
    document.querySelector('.rp-slash-item.is-active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [acSel, suggestions.length]);

  // ── /ls tree printer ──────────────────────────────────────────────────────
  function printLsTree(changesDir: string, folders: { name: string; files: string[] }[]) {
    const KNOWN_FILES: Record<string, string> = {
      'deploy.sql':  'DDL/DML to apply the change',
      'verify.sql':  'Assertions run after deploy',
      'revert.sql':  'SQL to undo the change',
    };
    const dirLabel = changesDir.replace(/\\/g, '/');
    vterm.writeln('');
    vterm.writeln(`  ${CI}${dirLabel}/${RST}`);
    if (folders.length === 0) {
      vterm.writeln(`  ${CD}  (no change folders found)${RST}`);
      return;
    }
    folders.forEach((folder, fi) => {
      const isLastFolder = fi === folders.length - 1;
      const fPrefix = isLastFolder ? `└──` : `├──`;
      vterm.writeln(`  ${CI}${fPrefix} ${CB}${folder.name}/${RST}`);
      const childPrefix = isLastFolder ? '    ' : `${CD}│${RST}   `;
      const files = folder.files.filter(f => f.endsWith('.sql') || !f.startsWith('.'));
      files.forEach((file, idx) => {
        const isLast = idx === files.length - 1;
        const filePrefix = isLast ? `└──` : `├──`;
        const hint = KNOWN_FILES[file] ? `  ${CD}# ${KNOWN_FILES[file]}${RST}` : '';
        vterm.writeln(`  ${childPrefix}${CI}${filePrefix}${RST} ${CC}${file}${RST}${hint}`);
      });
    });
    vterm.writeln('');
  }

  // ── Run a dmcr command ────────────────────────────────────────────────────
  const runCmd = useCallback((args: string[], display?: string) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const label = display ?? args.join(' ');
    runningCmdRef.current = label;
    setRunning(true);
    setRunningCmd(label);
    // Collapse only successful blocks; keep error blocks visible; keep the last finished block expanded
    setCollapsedBlocks(prev => {
      const next = new Set(prev);
      const allBlocks = vtermRef.current.getBlocks();
      const lastDone = [...allBlocks].reverse().find(b => b.status !== 'running');
      allBlocks.forEach(b => {
        if (b.status === 'done' && b.id !== lastDone?.id) next.add(b.id);
        // error blocks are never auto-collapsed
      });
      return next;
    });
    const blockId = vtermRef.current.startBlock(label);
    currentBlockIdRef.current = blockId;
    postMsg({ type: 'runDmcr', payload: { args, scriptPath: scriptPathRef.current || undefined } });
  }, []);

  // ── Show /help as a React card ────────────────────────────────────────────
  const showHelpCard = useCallback(() => {
    setCollapsedBlocks(prev => {
      const next = new Set(prev);
      const allBlocks = vtermRef.current.getBlocks();
      const lastDone = [...allBlocks].reverse().find(b => b.status !== 'running');
      allBlocks.forEach(b => {
        if (b.status === 'done' && b.id !== lastDone?.id) next.add(b.id);
      });
      return next;
    });
    const helpBlockId = vtermRef.current.startBlock('help');
    vtermRef.current.writeln('');
    vtermRef.current.endBlock('done');
    setJsonResults(prev => {
      const next = new Map(prev);
      next.set(helpBlockId, { command: 'help', args: [], exitCode: 0, data: { __help: true } });
      return next;
    });
  }, []);

  // ── Process a submitted line ───────────────────────────────────────────────
  const processLine = useCallback((line: string) => {
    if (!line.trim()) return;
    const trimmed = line.trim();

    if (historyRef.current[0] !== trimmed) {
      historyRef.current.unshift(trimmed);
      if (historyRef.current.length > 200) historyRef.current.pop();
    }
    histIdxRef.current = -1;

    if (trimmed === 'dmcr' || trimmed === 'DMCR') {
      printLogo(vterm); return;
    }

    // Quotes group words (tag create v1 "Release 1"); parse and ls take the rest of the line as typed
    const rawParts  = splitCommandArgs(trimmed);
    const restOfLine = trimmed.replace(/^(?:dmcr\s+)?\/?\S+\s*/i, '');
    const baseParts = rawParts[0]?.toLowerCase() === 'dmcr' ? rawParts.slice(1) : rawParts;
    if (baseParts.length === 0) return;

    const parts        = [...baseParts];
    const usedSlash    = parts[0].startsWith('/');
    const commandToken = usedSlash ? parts[0].slice(1) : parts[0];
    const command      = commandToken.toLowerCase();
    parts[0]           = commandToken;

    if (parts.includes('--help') || parts.includes('-h')) {
      vterm.writeln(''); printCommandHelp(vterm, command); return;
    }
    if (command === 'clear') {
      vtermRef.current.clear(); printLogo(vterm); setBotVisible(true); return;
    }
    if (command === 'help') {
      showHelpCard(); return;
    }
    if (command === 'config') {
      runCmd(['show', 'config'], trimmed); return;
    }
    if (command === 'ls') {
      const pattern = restOfLine.trim() || undefined;
      postMsg({ type: 'lsChanges', payload: { pattern, mode: 'ls', requestId: 'runner' } }); return;
    }
    if (command === 'it') {
      setItLoading(true);
      setItMode(true);
      postMsg({ type: 'lsChanges', payload: { mode: 'it', requestId: 'runner' } }); return;
    }
    if (command === 'sync') {
      vterm.writeln(`\r\n${CY}  ⏳ Syncing with remote...${RST}`);
      postMsg({ type: 'gitSync' }); return;
    }
    if (command === 'parse') {
      const sqlText = restOfLine.trim();
      if (!sqlText) {
        vterm.writeln(`\r\n${CY}  Usage: ${usedSlash ? '/parse <sql>' : 'parse <sql>'}${RST}`); return;
      }
      runCmd(['parse', sqlText], trimmed); return;
    }
    if (!VALID_BARE.has(command)) {
      // Collapse only successful blocks; keep error blocks expanded
      setCollapsedBlocks(prev => {
        const next = new Set(prev);
        const allBlocks = vtermRef.current.getBlocks();
        const lastDone = [...allBlocks].reverse().find(b => b.status !== 'running');
        allBlocks.forEach(b => {
          if (b.status === 'done' && b.id !== lastDone?.id) next.add(b.id);
        });
        return next;
      });
      // Show as an instant-fail RunCard; write one anchor line so computeSegments positions it correctly
      const errBlockId = vtermRef.current.startBlock(trimmed);
      vtermRef.current.writeln('');
      vtermRef.current.endBlock('error');
      setJsonResults(prev => {
        const next = new Map(prev);
        next.set(errBlockId, {
          command,
          args: parts,
          exitCode: 1,
          data: {
            __synthetic: true,
            status: 'error',
            message: `Unknown: ${command}\nNot a valid DMCR command. Type /help to see all available commands.`,
          },
        });
        return next;
      });
      return;
    }
    if (command === 'revert' && parts.length === 1) {
      vterm.writeln(`\r\n${CY}  Usage: ${usedSlash ? '/revert <change_id>' : 'revert <change_id>'}${RST}`);
      return;
    }
    runCmd(parts, trimmed);
  }, [runCmd, vterm, showHelpCard]);

  // ── Handle prompt key events ───────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // /it interactive mode
    if (itModeRef.current) {
      if (e.key === 'Escape' || (e.ctrlKey && e.key === 'c')) {
        e.preventDefault();
        if (itPhaseRef.current === 'action') { itPhaseRef.current = 'select'; setItTick(n => n + 1); return; }
        itModeRef.current = false; itPhaseRef.current = 'select'; setItMode(false); setItLoading(false);
        vterm.writeln(`\r\n  ${CD}Exited interactive mode.${RST}`);
        return;
      }
      if (itPhaseRef.current === 'select') {
        if (e.key === 'ArrowUp')   { e.preventDefault(); itSelRef.current = Math.max(0, itSelRef.current - 1); setItTick(n => n + 1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); itSelRef.current = Math.min(itFoldersRef.current.length - 1, itSelRef.current + 1); setItTick(n => n + 1); return; }
        if (e.key === 'Enter')     { e.preventDefault(); itPhaseRef.current = 'action'; itActionSelRef.current = 0; setItTick(n => n + 1); return; }
      } else if (itPhaseRef.current === 'action') {
        if (e.key === 'ArrowUp')                         { e.preventDefault(); itActionSelRef.current = Math.max(0, itActionSelRef.current - 1); setItTick(n => n + 1); return; }
        if (e.key === 'ArrowDown')                       { e.preventDefault(); itActionSelRef.current = Math.min(1, itActionSelRef.current + 1); setItTick(n => n + 1); return; }
        if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); itPhaseRef.current = 'select'; setItTick(n => n + 1); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          const folder  = itFoldersRef.current[itSelRef.current];
          const actions = [
            { cmd: ['revert', folder.name], hint: `dmcr revert ${folder.name}` },
            { cmd: ['revert', 'to', folder.name], hint: `dmcr revert to ${folder.name}` },
          ];
          const chosen = actions[itActionSelRef.current];
          itModeRef.current = false; itPhaseRef.current = 'select'; setItMode(false);
          vterm.writeln(`\r\n  ${CI}❯${RST} Running: ${CC}${chosen.hint}${RST}`);
          runCmd(chosen.cmd, chosen.hint);
          return;
        }
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      // If slash palette is open, apply the selected suggestion
      const sug = computeSuggestions(lineBufferRef.current);
      if (sug.length > 0) {
        const completion = sug[acSelRef.current] ?? sug[0];
        lineBufferRef.current = ''; setLineBuffer(''); acSelRef.current = 0; setAcSel(0);
        if (completion.special === 'clear') { handleClear(); return; }
        if (completion.special === 'help')  { showHelpCard(); return; }
        if (completion.special === 'sync')  { vterm.writeln(`\r\n${CY}  ⏳ Syncing...${RST}`); postMsg({ type: 'gitSync' }); return; }
        if (completion.special === 'it')    { setItLoading(true); setItMode(true); postMsg({ type: 'lsChanges', payload: { mode: 'it', requestId: 'runner' } }); promptRef.current?.focus(); return; }
        if (completion.args) { runCmd(completion.args, completion.label); }
        else { const text = completion.cmd + ' '; lineBufferRef.current = text; setLineBuffer(text); }
        return;
      }
      const line = lineBufferRef.current;
      lineBufferRef.current = ''; setLineBuffer(''); acSelRef.current = 0; setAcSel(0); histIdxRef.current = -1;
      if (line.trim()) {
        vterm.writeln(`${CI}❯${RST} ${CB}dmcr${RST} ${CI}›${RST} ${line}`);
        processLine(line);
      }
      return;
    }
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      lineBufferRef.current = ''; setLineBuffer(''); acSelRef.current = 0; setAcSel(0);
      vterm.writeln(`${CD}^C${RST}`);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      lineBufferRef.current = ''; setLineBuffer(''); acSelRef.current = 0; setAcSel(0);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const sug = computeSuggestions(lineBufferRef.current);
      if (sug.length > 0) {
        const completion = sug[acSelRef.current] ?? sug[0];
        if (completion.special === 'clear') { handleClear(); return; }
        if (completion.special === 'help')  { lineBufferRef.current = ''; setLineBuffer(''); showHelpCard(); return; }
        if (completion.args) { lineBufferRef.current = ''; setLineBuffer(''); runCmd(completion.args, completion.label); }
        else { const text = completion.cmd + ' '; lineBufferRef.current = text; setLineBuffer(text); }
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const sug = computeSuggestions(lineBufferRef.current);
      if (sug.length > 0) { const n = Math.max(0, acSelRef.current - 1); acSelRef.current = n; setAcSel(n); }
      else {
        const n = Math.min(historyRef.current.length - 1, histIdxRef.current + 1);
        if (n >= 0) { histIdxRef.current = n; const e2 = historyRef.current[n]; lineBufferRef.current = e2; setLineBuffer(e2); }
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const sug = computeSuggestions(lineBufferRef.current);
      if (sug.length > 0) { const n = Math.min(sug.length - 1, acSelRef.current + 1); acSelRef.current = n; setAcSel(n); }
      else {
        const n = histIdxRef.current - 1;
        if (n >= 0) { histIdxRef.current = n; const e2 = historyRef.current[n]; lineBufferRef.current = e2; setLineBuffer(e2); }
        else { histIdxRef.current = -1; lineBufferRef.current = ''; setLineBuffer(''); }
      }
      return;
    }
  }, [processLine, runCmd, vterm, showHelpCard]);

  // ── Clear ─────────────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    vtermRef.current.clear();
    printLogo(vterm);
    setCollapsedBlocks(new Set());
    setJsonResults(new Map());
    currentBlockIdRef.current = -1;
    lineBufferRef.current = ''; setLineBuffer(''); setAcSel(0);
    setBotVisible(true);
    promptRef.current?.focus();
  }, [vterm]);

  // ── Copy output ────────────────────────────────────────────────────────────
  const handleCopyOutput = useCallback(() => {
    const buf  = vtermRef.current.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const ln = buf.getLine(i);
      if (ln) rows.push(ln.translateToString(true));
    }
    while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
    navigator.clipboard.writeText(rows.join('\n')).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, []);

  // ── Message listener ───────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (evt: MessageEvent) => {
      const msg = evt.data;

      if (msg?.type === 'filePicked' && msg?.payload?.path && msg?.payload?.requestId === 'runner:scriptPath') {
        scriptPathRef.current = msg.payload.path;
        setScriptPath(msg.payload.path);
      }

      if (msg?.type === 'lsChangesResult' && msg?.payload?.requestId === 'runner') {
        const { error, changesDir, folders, mode } = msg.payload as {
          error?: string; changesDir?: string;
          folders?: { name: string; files: string[] }[]; mode?: 'ls' | 'it';
        };
        if (error) {
          setItLoading(false); setItMode(false); itModeRef.current = false;
          vterm.writeln(`\r\n  ${CR}✗  ${error}${RST}`); return;
        }
        if (!folders || !changesDir) return;
        if (mode === 'it') {
          itFoldersRef.current  = folders;
          itSelRef.current      = 0;
          itPhaseRef.current    = 'select';
          itActionSelRef.current = 0;
          itModeRef.current     = true;
          setItLoading(false);
          setItMode(true);
          promptRef.current?.focus();
        } else {
          printLsTree(changesDir, folders);
        }
      }

      if (msg?.type === 'gitSyncResult') {
        const { ok, commitHash, commitMessage, error: syncErr } = msg.payload as {
          ok: boolean; commitHash?: string; commitMessage?: string; error?: string;
        };
        const vt = vtermRef.current;
        vt.startBlock('git sync');
        if (ok) {
          vt.writeln(`  ${CG}✓  Synced successfully${RST}`);
          if (commitHash)    vt.writeln(`  ${CD}  commit ${commitHash.slice(0, 8)}${RST}`);
          if (commitMessage) vt.writeln(`  ${CD}  ${commitMessage}${RST}`);
        } else {
          vt.writeln(`  ${CR}✗  Sync failed${RST}`);
          vt.writeln(`  ${CD}  ${syncErr || 'unknown error'}${RST}`);
        }
        vt.endBlock(ok ? 'done' : 'error');
      }

      if (msg?.type === 'terminalJsonResult') {
        const { command, args, exitCode, data } = msg.payload as JsonCommandResult;
        const blockId = currentBlockIdRef.current;
        if (blockId >= 0) {
          setJsonResults(prev => {
            const next = new Map(prev);
            next.set(blockId, { command, args, exitCode, data });
            return next;
          });
        }
      }

      if (msg?.type === 'gitStatus') {
        setGitBranch(msg.payload?.branch ?? null);
        setGitDirty(!!msg.payload?.dirty);
      }
      if (msg?.type === 'runnerHistory') {
        setRunHistory(msg.payload ?? []);
      }
      if (msg?.type === 'changeExplainResult') {
        const { id, explanation } = msg.payload as { id: number; explanation: string };
        setExplainText(prev => ({ ...prev, [id]: explanation }));
        setExplainId(null);
        const p = pendingExplainRef.current;
        if (p?.rowId === id) { setAiPopup({ type: 'explain', rowId: id, cmd: p.cmd }); pendingExplainRef.current = null; }
      }
      if (msg?.type === 'riskScoreResult') {
        const { blockId, scores } = msg.payload as { blockId: number; scores: RiskScoreRow[] };
        setRiskScores(prev => { const m = new Map(prev); m.set(blockId, scores); return m; });
        setAnalyzingRisk(prev => { const s = new Set(prev); s.delete(blockId); return s; });
      }
      if (msg?.type === 'rollbackAdvisoryResult') {
        const { id, advisory } = msg.payload as { id: number; advisory: string };
        setRollbackText(prev => ({ ...prev, [id]: advisory }));
        setRollbackId(null);
        const p = pendingRollbackRef.current;
        if (p?.rowId === id) { setAiPopup({ type: 'rollback', rowId: id, cmd: p.cmd }); pendingRollbackRef.current = null; }
      }
      if (msg?.type === 'changelogResult') {
        setGeneratingChangelog(false);
        if (msg.payload?.changelog) { setChangelogMarkdown(msg.payload.changelog); setShowChangelogPopup(true); }
      }
      if (msg?.type === 'runnerHistoryDeleted') {
        setRunHistory([]);
      }
      if (msg?.type === 'ticketLinkerResult') {
        setLinkingTickets(false);
        setTicketLinks(msg.payload?.links ?? null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch git status on mount for branch badge ────────────────────────────
  useEffect(() => { postMsg({ type: 'getGitStatus' }); }, []);

  // ── onReady handle — streams shell output into VirtualTerm ────────────────
  useEffect(() => {
    const vt = vtermRef.current;

    onReady({
      write: (d) => {
        // If running, data goes directly into the current RunBlock
        vt.write(d);
      },
      writeln: (d) => { vt.writeln(d); },
      clear:   () => {
        vt.clear();
        printLogo(vt as unknown as TermLike);
        setBotVisible(true);
      },
    });

    (window as unknown as { __dmcrRunnerSetRunning?: (v: boolean, err?: boolean) => void })
      .__dmcrRunnerSetRunning = (v: boolean, err?: boolean) => {
        setRunning(v);
        runningRef.current = v;
        if (!v) {
          setRunningCmd('');
          runningCmdRef.current = '';
          // End the RunCard block with done or error status
          vtermRef.current.endBlock(err ? 'error' : 'done');
        }
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Preset toolbar ────────────────────────────────────────────────────────
  const handlePreset = useCallback((args: string[], label: string) => {
    if (running) return;
    lineBufferRef.current = ''; setLineBuffer(''); setAcSel(0);
    promptRef.current?.focus();
    runCmd(args, label);
  }, [running, runCmd]);

  // PRESET_COLOR removed — use p.color from PRESETS directly

  // Suppress unused-var warning for refs used only via closures
  void itTick;
  void writePrompt;
  void SLASH_CMDS;
  void LOGO_LINES;

  // ── Computed segments for rendering ──────────────────────────────────────
  const segments = computeSegments(lines, currentLine, blocks);

  return (
    <div
      data-theme={isDark ? 'dark' : 'light'}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: isDark ? '#0d1117' : '#f8fafc' }}
    >

      {/* ── Preset toolbar ─────────────────────────────────────────────────── */}
      <div className="rp-toolbar">
        {PRESETS.map(p => (
          <ButtonView
            key={p.label}
            label={p.label}
            variant="primary"
            accentColor={p.color}
            size="md"
            disabled={running}
            title={p.desc}
            onClick={() => handlePreset(p.args, p.label)}
          />
        ))}
        <div style={{ flex: 1 }} />
        {gitBranch && (() => {
          const branchColor = gitDirty ? '#f59e0b' : '#6366f1';
          return (
            <span
              title={gitDirty ? 'Branch has uncommitted changes' : 'Branch is clean'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                height: 28, padding: '0 10px', borderRadius: 9999,
                background: `color-mix(in srgb, ${branchColor} 10%, transparent)`,
                border: `1px solid color-mix(in srgb, ${branchColor} 28%, transparent)`,
                color: branchColor,
                fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                fontFamily: 'ui-monospace, monospace',
                transition: 'all 120ms ease',
                cursor: 'default',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
              </svg>
              {gitBranch}{gitDirty ? ' *' : ''}
            </span>
          );
        })()}
        <IconButtonView
          icon={copied
            ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          }
          tooltip={copied ? 'Copied!' : 'Copy output'}
          accentColor={copied ? '#10b981' : '#94a3b8'}
          color={copied ? '#10b981' : undefined}
          active={copied}
          size="sm"
          onClick={handleCopyOutput}
          style={{ transition: 'color 200ms, background 200ms' }}
        />
        <IconButtonView
          icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>}
          tooltip="Clear terminal"
          accentColor="#f87171"
          size="sm"
          onClick={() => setShowClearConfirm(true)}
        />
      </div>

      {/* ── Clear confirm modal ─────────────────────────────────────────────── */}
      <ModalView
        open={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="Clear terminal?"
        size="sm"
        footerRight={
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setShowClearConfirm(false)}
              style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid rgba(100,116,139,0.35)', background: 'transparent', color: '#94a3b8', fontSize: 12, cursor: 'pointer' }}
            >Cancel</button>
            <button
              type="button"
              onClick={() => { setShowClearConfirm(false); handleClear(); }}
              style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.12)', color: '#f87171', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >Clear</button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: '#94a3b8', lineHeight: 1.55 }}>
          All terminal output will be cleared. Are you sure?
        </p>
      </ModalView>

      {/* ── AI result popup ─────────────────────────────────────────────────── */}
      {(() => {
        if (!aiPopup) return null;
        const { type, rowId: rid, cmd: popupCmd } = aiPopup;
        const titleMap = { explain: '✦ AI Change Explainer', rollback: '↩ AI Rollback Advisor' };
        const accentMap = { explain: '#818cf8', rollback: '#f87171' };
        const accent = accentMap[type];
        const isLoading = (type === 'explain' && explainId === rid) || (type === 'rollback' && rollbackId === rid);
        const explainContent = explainText[rid];
        const rollbackContent = rollbackText[rid];
        return (
          <ModalView
            open
            onClose={() => setAiPopup(null)}
            title={titleMap[type]}
            headerColor={accent}
            size="md"
          >
            <div style={{ minHeight: 80 }}>
              {/* sub-label showing which change */}
              <div style={{ marginBottom: 10, padding: '3px 8px', borderRadius: 5, background: 'rgba(255,255,255,0.04)', display: 'inline-block', fontFamily: 'monospace', fontSize: 11, color: '#64748b' }}>{popupCmd}</div>

              {isLoading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 0', color: '#64748b', fontSize: 12 }}>
                  <span style={{ display: 'inline-flex', gap: 3 }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent, animation: 'pulse 1.2s ease-in-out infinite', animationDelay: '0s' }} />
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent, animation: 'pulse 1.2s ease-in-out infinite', animationDelay: '0.2s' }} />
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent, animation: 'pulse 1.2s ease-in-out infinite', animationDelay: '0.4s' }} />
                  </span>
                  Analyzing…
                </div>
              )}

              {!isLoading && type === 'explain' && explainContent && (
                <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                  <MarkdownView content={explainContent} />
                </div>
              )}
              {!isLoading && type === 'rollback' && rollbackContent && (
                <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                  <MarkdownView content={rollbackContent} />
                </div>
              )}
            </div>
          </ModalView>
        );
      })()}

      {/* ── Changelog popup ─────────────────────────────────────────────────── */}
      <ModalView
        open={showChangelogPopup}
        onClose={() => setShowChangelogPopup(false)}
        title="✦ AI Generated Changelog"
        headerColor="#38bdf8"
        size="lg"
        footerRight={
          changelogMarkdown ? (
            <button
              type="button"
              onClick={() => postMsg({ type: 'saveTextFile', payload: { content: changelogMarkdown, filename: 'CHANGELOG.md' } })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 14px', borderRadius: 6, border: '1px solid rgba(14,165,233,0.4)', background: 'rgba(14,165,233,0.12)', color: '#38bdf8', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Export CHANGELOG.md
            </button>
          ) : undefined
        }
      >
        {changelogMarkdown ? (
          <div style={{ maxHeight: 480, overflowY: 'auto' }}>
            <MarkdownView content={changelogMarkdown} />
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '24px 0', color: '#64748b', fontSize: 12 }}>
            <span style={{ display: 'inline-flex', gap: 3 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#38bdf8', animation: 'pulse 1.2s ease-in-out infinite', animationDelay: '0s' }} />
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#38bdf8', animation: 'pulse 1.2s ease-in-out infinite', animationDelay: '0.2s' }} />
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#38bdf8', animation: 'pulse 1.2s ease-in-out infinite', animationDelay: '0.4s' }} />
            </span>
            Generating changelog…
          </div>
        )}
      </ModalView>

      {/* ── Delete history confirm modal ─────────────────────────────────────── */}
      <ModalView
        open={showDeleteHistoryConfirm}
        onClose={() => setShowDeleteHistoryConfirm(false)}
        title="Delete run history?"
        size="sm"
        footerRight={
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setShowDeleteHistoryConfirm(false)}
              style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid rgba(100,116,139,0.35)', background: 'transparent', color: '#94a3b8', fontSize: 12, cursor: 'pointer' }}
            >Cancel</button>
            <button
              type="button"
              onClick={() => {
                setShowDeleteHistoryConfirm(false);
                postMsg({ type: 'deleteRunnerHistory' });
                setRunHistory([]);
                setExplainText({});
                setRollbackText({});
                setAiPopup(null);
              }}
              style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.12)', color: '#f87171', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >Delete All</button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: '#94a3b8', lineHeight: 1.55 }}>
          All {runHistory.length} run entries will be permanently deleted. This cannot be undone.
        </p>
      </ModalView>

      {/* ── Processing bar ──────────────────────────────────────────────────── */}
      {running && (
        <div className="rp-processing">
          <div className="rp-thinking-icon">
            <span className="rp-thinking-dot" /><span className="rp-thinking-dot" /><span className="rp-thinking-dot" />
          </div>
          <span className="rp-processing-text">Running</span>
          {runningCmd && <span className="rp-processing-cmd">dmcr {runningCmd}</span>}
        </div>
      )}

      {/* ── Output area ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>

        <div
          ref={outputRef}
          className="rp-output"
          onClick={() => promptRef.current?.focus()}
        >
          {segments.map((seg, i) =>
            seg.type === 'static' ? (
              <div key={`s${i}`}>
                {seg.lines.map(l => (
                  <div key={l.id} className="rp-output-line" dangerouslySetInnerHTML={{ __html: l.html || '&nbsp;' }} />
                ))}
                {seg.currentLine && (
                  <div className="rp-output-line rp-output-line--current" dangerouslySetInnerHTML={{ __html: seg.currentLine.html || '&nbsp;' }} />
                )}
              </div>
            ) : (
              <RunCard
                key={`r${seg.block.id}`}
                block={seg.block}
                lines={seg.lines}
                currentLine={seg.currentLine}
                collapsed={collapsedBlocks.has(seg.block.id)}
                jsonResult={jsonResults.get(seg.block.id)}
                riskScores={riskScores.get(seg.block.id)}
                isAnalyzingRisk={analyzingRisk.has(seg.block.id)}
                onAnalyzeRisk={!isAiOn('AI_RISK_SCORER') ? undefined : () => {
                  const jr = jsonResults.get(seg.block.id);
                  if (!jr) return;
                  const changes = ((jr.data as Record<string,unknown>)?.['changes'] as Array<{change_id:string}>) ?? [];
                  if (changes.length === 0) return;
                  setAnalyzingRisk(prev => new Set([...prev, seg.block.id]));
                  postMsg({ type: 'analyzeRisk', payload: { blockId: seg.block.id, changes } });
                }}
                onToggle={() => setCollapsedBlocks(prev => {
                  const next = new Set(prev);
                  if (next.has(seg.block.id)) next.delete(seg.block.id);
                  else next.add(seg.block.id);
                  return next;
                })}
              />
            )
          )}
        </div>

        {/* Bot mascot */}
        <BotAsciiArt visible={botVisible} />

        {/* /it overlay */}
        {(itMode || itLoading) && (
          <ItOverlay
            phase={itPhaseRef.current}
            folders={itFoldersRef.current}
            sel={itSelRef.current}
            actionSel={itActionSelRef.current}
            loading={itLoading}
          />
        )}

        {/* Slash command palette — anchored above prompt, grows upward */}
        {suggestions.length > 0 && (
          <div className="rp-slash-palette">
            <div className="rp-slash-head">
              <div className="rp-slash-title-row">
                <span className="rp-slash-icon">/</span>
                <div>
                  <div className="rp-slash-title">Command Search</div>
                  <div className="rp-slash-subtitle">↑↓ navigate · Enter to run · Esc dismiss</div>
                </div>
              </div>
              <div className="rp-slash-searchline">
                <span className="rp-slash-searchlabel">Query</span>
                <code>{slashQuery || 'all commands'}</code>
              </div>
            </div>
            {suggestions.map((s, i) => (
              <div
                key={s.cmd}
                className={`rp-slash-item${i === acSel ? ' is-active' : ''}`}
                onMouseEnter={() => { acSelRef.current = i; setAcSel(i); }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  lineBufferRef.current = ''; setLineBuffer(''); setAcSel(0);
                  if (s.special === 'clear') { handleClear(); return; }
                  if (s.special === 'help')  { showHelpCard(); return; }
                  if (s.special === 'sync')  { vterm.writeln(`\r\n${CY}  ⏳ Syncing...${RST}`); postMsg({ type: 'gitSync' }); return; }
                  if (s.special === 'it')    { setItLoading(true); setItMode(true); postMsg({ type: 'lsChanges', payload: { mode: 'it', requestId: 'runner' } }); promptRef.current?.focus(); return; }
                  if (s.args) { runCmd(s.args, s.label); }
                  else { const text = s.cmd + ' '; lineBufferRef.current = text; setLineBuffer(text); }
                }}
              >
                <span className="rp-slash-accent" style={{ background: s.color }} />
                <div className="rp-slash-main">
                  <div className="rp-slash-line1">
                    <span className="rp-slash-cmd">{s.label}</span>
                    <span className="rp-slash-group">{s.group}</span>
                  </div>
                  <div className="rp-slash-line2">{s.hint}</div>
                </div>
              </div>
            ))}
            <div className="rp-slash-foot">Tab to complete · Enter to run · ↑↓ navigate · Esc dismiss</div>
          </div>
        )}

        {/* ── Inline prompt — absolute at bottom of output container ── */}
        <div className="rp-prompt-row" onClick={() => promptRef.current?.focus()}>
          <span className="rp-prompt-sym">❯</span>
          <span className="rp-prompt-dmcr">dmcr</span>
          <span className="rp-prompt-arrow">›</span>
          <input
            ref={promptRef}
            className="rp-prompt-input"
            value={lineBuffer}
            disabled={running}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={e => {
              const v = e.target.value;
              lineBufferRef.current = v; setLineBuffer(v); acSelRef.current = 0; setAcSel(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={running ? 'Running…' : ''}
          />
          {running && <span className="rp-prompt-spinner" />}
        </div>
      </div>

      {/* ── Recent Runs (D6.7) ───────────────────────────────────────────── */}
      <details
        className="rp-script-details"
        open={historyOpen}
        onToggle={e => {
          const open = (e.currentTarget as HTMLDetailsElement).open;
          setHistoryOpen(open);
          if (open) postMsg({ type: 'getRunnerHistory' });
        }}
      >
        <summary className="rp-script-summary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>⏱ recent runs ({runHistory.length})</span>
          {runHistory.length > 0 && (
            <button
              type="button"
              title="Delete all run history"
              onClick={e => { e.preventDefault(); e.stopPropagation(); setShowDeleteHistoryConfirm(true); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0 2px', lineHeight: 1, display: 'flex', alignItems: 'center' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
              onMouseLeave={e => (e.currentTarget.style.color = '#475569')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
          )}
        </summary>
        <div style={{ padding: '6px 0', maxHeight: 200, overflowY: 'auto' }}>
          {runHistory.length > 0 && (isAiOn('AI_CHANGELOG_GENERATOR') || isAiOn('AI_TICKET_LINKER')) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 0 6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {isAiOn('AI_CHANGELOG_GENERATOR') && <button
                  style={{ fontSize: 9.5, padding: '1px 7px', borderRadius: 4, border: `1px solid ${changelogMarkdown ? 'rgba(14,165,233,0.5)' : 'rgba(14,165,233,0.3)'}`, background: changelogMarkdown ? 'rgba(14,165,233,0.15)' : 'rgba(14,165,233,0.08)', color: '#38bdf8', cursor: generatingChangelog ? 'default' : 'pointer', fontFamily: 'sans-serif', opacity: generatingChangelog ? 0.7 : 1 }}
                  disabled={generatingChangelog}
                  title="AI Changelog Generator"
                  onClick={() => {
                    if (changelogMarkdown) { setShowChangelogPopup(true); return; }
                    setGeneratingChangelog(true);
                    const historyRows = runHistory.filter(r => r.action === 'exit' && r.status === 'success' && r.command).map(r => ({ change_id: r.command ?? '', applied_at: r.event_ts ?? '', environment: '' }));
                    postMsg({ type: 'generateChangelog', payload: { historyRows } });
                  }}
                >{generatingChangelog ? '✦ Generating…' : '✦ Generate Changelog'}</button>}
                {/* D19.10 — Ticket Linker */}
                {isAiOn('AI_TICKET_LINKER') && <button
                  style={{ fontSize: 9.5, padding: '1px 7px', borderRadius: 4, border: '1px solid rgba(14,165,233,0.3)', background: 'rgba(14,165,233,0.08)', color: '#38bdf8', cursor: linkingTickets ? 'default' : 'pointer', fontFamily: 'sans-serif', opacity: linkingTickets ? 0.7 : 1 }}
                  disabled={linkingTickets}
                  title="AI Ticket Linker — link git commits to Jira/Linear tickets"
                  onClick={() => {
                    setLinkingTickets(true);
                    setTicketLinks(null);
                    const changeNames = [...new Set(runHistory.filter(r => r.command).map(r => r.command!))];
                    postMsg({ type: 'linkTickets', payload: { changeNames } });
                  }}
                >{linkingTickets ? '🎫 Linking…' : '🎫 Link Tickets'}</button>}
              </div>
              {/* D19.10 ticket links result */}
              {ticketLinks && ticketLinks.length > 0 && (
                <div style={{ marginTop: 4, borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(14,165,233,0.2)', background: 'rgba(14,165,233,0.04)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', background: 'rgba(14,165,233,0.1)', borderBottom: '1px solid rgba(14,165,233,0.15)' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#38bdf8' }}>🎫 AI Ticket Links</span>
                  </div>
                  {ticketLinks.map((l, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px', borderBottom: i < ticketLinks.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none', fontSize: 10 }}>
                      <span style={{ color: '#818cf8', fontFamily: 'monospace', minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.changeName}</span>
                      <span style={{ color: '#38bdf8', fontWeight: 600 }}>{l.ticketId || '—'}</span>
                      <span style={{ color: '#64748b' }}>{l.ticketSystem}</span>
                      <span style={{ color: l.confidence === 'high' ? '#4ade80' : l.confidence === 'medium' ? '#fbbf24' : '#94a3b8', marginLeft: 'auto' }}>{l.confidence}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {runHistory.length === 0 ? (
            <p style={{ fontSize: 11, color: '#64748b', padding: '4px 0', margin: 0 }}>No runs recorded yet.</p>
          ) : runHistory.map((r, i) => {
            const ts = r.event_ts ? new Date(r.event_ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            const exitOk = r.exit_code == null || r.exit_code === 0;
            const rowId = r.id ?? i;
            const cmd = r.command ?? r.action;
            const rid = rowId as number;
            const explanation = explainText[rid];
            const rollback    = rollbackText[rid];
            const isExplaining  = explainId === rid;
            const isRollingBack = rollbackId === rid;
            const hasResult = !!(explanation || rollback);
            return (
              <div key={rowId}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: hasResult ? 'none' : '1px solid rgba(255,255,255,0.04)', fontSize: 11, fontFamily: 'monospace', flexWrap: 'wrap' }}>
                  <span style={{ color: exitOk ? '#4ade80' : '#f87171', flexShrink: 0 }}>{exitOk ? '✓' : '✗'}</span>
                  <span style={{ color: '#818cf8', flexShrink: 0, minWidth: 80 }}>{cmd}</span>
                  <span style={{ color: '#64748b', flexShrink: 0 }}>{ts}</span>
                  {r.duration_ms != null && <span style={{ color: '#94a3b8' }}>{r.duration_ms < 1000 ? `${r.duration_ms}ms` : `${(r.duration_ms / 1000).toFixed(1)}s`}</span>}
                  <span style={{ marginLeft: 'auto' }} />
                  {isAiOn('AI_CHANGE_EXPLAINER') && <button
                    style={{ fontSize: 9.5, padding: '1px 6px', borderRadius: 4, border: `1px solid ${explanation ? 'rgba(99,102,241,0.5)' : 'rgba(99,102,241,0.3)'}`, background: explanation ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.08)', color: '#818cf8', cursor: 'pointer', fontFamily: 'sans-serif', flexShrink: 0 }}
                    title="AI Change Explainer"
                    disabled={isExplaining}
                    onClick={() => {
                      if (explanation) { setAiPopup({ type: 'explain', rowId: rid, cmd }); return; }
                      pendingExplainRef.current = { rowId: rid, cmd };
                      setExplainId(rid);
                      postMsg({ type: 'explainChange', payload: { id: rid, command: cmd } });
                    }}
                  >{isExplaining ? '…' : '✦ Explain'}</button>}
                  {isAiOn('AI_ROLLBACK_ADVISOR') && <button
                    style={{ fontSize: 9.5, padding: '1px 6px', borderRadius: 4, border: `1px solid ${rollback ? 'rgba(239,68,68,0.5)' : 'rgba(239,68,68,0.3)'}`, background: rollback ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.08)', color: '#f87171', cursor: 'pointer', fontFamily: 'sans-serif', flexShrink: 0 }}
                    title="AI Rollback Advisor"
                    disabled={isRollingBack}
                    onClick={() => {
                      if (rollback) { setAiPopup({ type: 'rollback', rowId: rid, cmd }); return; }
                      pendingRollbackRef.current = { rowId: rid, cmd };
                      setRollbackId(rid);
                      postMsg({ type: 'rollbackAdvisor', payload: { id: rid, command: cmd } });
                    }}
                  >{isRollingBack ? '…' : '↩ Revert'}</button>}
                </div>
              </div>
            );
          })}
        </div>
      </details>

      {/* ── Script path override ─────────────────────────────────────────── */}
      <details className="rp-script-details">
        <summary className="rp-script-summary">⚙ script path override</summary>
        <div className="rp-script-body">
          <input
            className="rp-script-input"
            placeholder={/Win/i.test(navigator.platform) ? 'C:\\path\\to\\dmcr.ps1  (blank = bundled auto-detect)' : '/usr/local/bin/dmcr.sh  (blank = bundled auto-detect)'}
            value={scriptPath}
            onChange={e => { scriptPathRef.current = e.target.value; setScriptPath(e.target.value); }}
          />
          <button
            className="rp-script-btn"
            onClick={() => postMsg({ type: 'pickFile', payload: { requestId: 'runner:scriptPath', filters: { 'Runner script': ['ps1', 'sh'], 'All Files': ['*'] } } })}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            Browse
          </button>
          {scriptPath && (
            <button className="rp-script-clear" onClick={() => { scriptPathRef.current = ''; setScriptPath(''); }} title="Clear">✕</button>
          )}
        </div>
      </details>
    </div>
  );
}
