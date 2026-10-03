import React, { useState, useCallback, useEffect, useRef } from 'react';
import { DiffEditorView, EditorView, MarkdownView, ModalView } from '@salilvnair/dui';
import StyledDropdown from '../components/StyledDropdown';
import { postMsg } from '../vscode';
import './SchemaDiffPage.css';

type SchemaMcpResult = {
  ok: boolean;
  data?: unknown;
  aiAnalysis?: DriftAnalysis | null;
  error?: string;
};

type DriftAnalysis = {
  riskLevel: 'high' | 'medium' | 'low' | 'none';
  headline: string;
  summary: string;
  missingFromTarget: string;
  extraInTarget: string;
  ddlChanges: string;
  migrationAdvice: string;
  inSyncNote: string;
};

type McpSchemaInfo = {
  name: string;
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  tables: string[];
  views: string[];
  functions: string[];
  sequences: string[];
};

type McpPane = {
  serverId: string;
  schemas: McpSchemaInfo[];
  loading: boolean;
  selectedSchema: string;
};

type DdlPair = { id: string; schema: string; name: string; type: string; sourceDdl: string; targetDdl: string };

type Props = {
  visible: boolean;
  form: string;     // 'schema_diff'
  availableSchemas?: string[];
  existingChanges?: string[];
};

export default function SchemaDiffPage({ visible, form }: Props) {
  // AI mode state
  const emptyPane = (): McpPane => ({ serverId: '', schemas: [], loading: false, selectedSchema: '' });
  const [allServers, setAllServers] = useState<{ id: string; name: string; connAvailable: boolean }[]>([]);
  const [srcPane, setSrcPane] = useState<McpPane>(emptyPane());
  const [tgtPane, setTgtPane] = useState<McpPane>(emptyPane());
  const [aiRunning, setAiRunning] = useState(false);
  const [aiProgress, setAiProgress] = useState('');
  const [aiResult, setAiResult] = useState<SchemaMcpResult | null>(null);

  const [srcLeafSel, setSrcLeafSel] = useState<Set<string>>(new Set());
  const [tgtLeafSel, setTgtLeafSel] = useState<Set<string>>(new Set());

  const [diffPairs, setDiffPairs] = useState<DdlPair[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffViewActive, setDiffViewActive] = useState(false);

  // D18.10 — Drift Detective
  const [driftScheduling, setDriftScheduling] = useState(false);
  const [driftScheduled, setDriftScheduled] = useState(false);
  const [driftProgress, setDriftProgress] = useState('');
  const [driftResult, setDriftResult] = useState<Record<string, unknown> | null>(null);

  // D19.2 — Explain Diff
  const [explainRunning, setExplainRunning] = useState(false);
  const [diffExplanation, setDiffExplanation] = useState<string | null>(null);

  // ── Message listener ─────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.payload?.form && msg.payload.form !== form) return;

      switch (msg.type) {
        case 'diffMcpServers': {
          const servers = (msg.payload ?? []) as { id: string; name: string; connAvailable: boolean }[];
          setAllServers(servers);
          break;
        }
        case 'mcpSchemas': {
          const sid = msg.payload?.serverId as string | undefined;
          const connected = !!msg.payload?.connected;
          const schemaNames = connected ? (msg.payload?.schemas as string[] ?? []) : [];
          const makeSchemas = () => schemaNames.map((name: string) => ({ name, expanded: false, loading: false, loaded: false, tables: [], views: [], functions: [], sequences: [] }));
          const updater = (p: McpPane) => p.serverId === sid ? { ...p, loading: false, schemas: makeSchemas() } : p;
          setSrcPane(updater);
          setTgtPane(updater);
          break;
        }
        case 'mcpObjects': {
          const { schema: oSchema, serverId: oSid, objects, error: oErr } = (msg.payload ?? {}) as { schema: string; serverId?: string; objects: { tables: string[]; views: string[]; functions: string[]; sequences: string[] } | null; error?: string };
          if (oErr || !objects) break;
          const updater = (p: McpPane) => {
            if (oSid && p.serverId !== oSid) return p;
            return { ...p, schemas: p.schemas.map(s => s.name === oSchema ? { ...s, loading: false, loaded: true, tables: objects.tables ?? [], views: objects.views ?? [], functions: objects.functions ?? [], sequences: objects.sequences ?? [] } : s) };
          };
          setSrcPane(updater);
          setTgtPane(updater);
          break;
        }
        case 'schemaMcpProgress':
          if (msg.payload?.text) setAiProgress(msg.payload.text);
          break;
        case 'schemaMcpResult':
          setAiRunning(false);
          setAiProgress('');
          setAiResult({ ok: !!msg.payload?.ok, data: msg.payload?.data, aiAnalysis: msg.payload?.aiAnalysis, error: msg.payload?.error });
          break;
        case 'ddlPairsResult':
          setDiffLoading(false);
          if (msg.payload?.ok) setDiffPairs(msg.payload.pairs ?? []);
          break;
        case 'driftScheduleAck':
          setDriftScheduled(true);
          setDriftProgress('Running drift check…');
          break;
        case 'driftScheduleProgress':
          setDriftProgress(msg.payload?.text ?? '');
          break;
        case 'driftScheduleResult':
          setDriftScheduling(false);
          setDriftProgress('');
          setDriftResult(msg.payload ?? null);
          break;
        case 'diffExplanationResult':
          setExplainRunning(false);
          setDiffExplanation(msg.payload?.explanation ?? null);
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [form]);

  useEffect(() => { postMsg({ type: 'listMcpServers' }); }, []);

  // ── Actions ──────────────────────────────────────────────────────
  const handlePaneServerSelect = useCallback((side: 'src' | 'tgt', serverId: string) => {
    const setter = side === 'src' ? setSrcPane : setTgtPane;
    setter({ serverId, schemas: [], loading: true, selectedSchema: '' });
    if (serverId) postMsg({ type: 'discoverMcpSchemas', payload: { serverId } });
  }, []);

  const handleSchemaToggle = useCallback((side: 'src' | 'tgt', schemaName: string) => {
    const pane = side === 'src' ? srcPane : tgtPane;
    const setter = side === 'src' ? setSrcPane : setTgtPane;
    const schema = pane.schemas.find(s => s.name === schemaName);
    if (!schema) return;
    setter(p => ({ ...p, schemas: p.schemas.map(s => s.name === schemaName ? { ...s, expanded: !s.expanded } : s) }));
    if (!schema.loaded && !schema.loading) {
      setter(p => ({ ...p, schemas: p.schemas.map(s => s.name === schemaName ? { ...s, loading: true } : s) }));
      postMsg({ type: 'discoverMcpObjects', payload: { schema: schemaName, serverId: pane.serverId } });
    }
  }, [srcPane, tgtPane]);

  const handleSchemaSelect = useCallback((side: 'src' | 'tgt', schemaName: string) => {
    const setter = side === 'src' ? setSrcPane : setTgtPane;
    setter(p => ({ ...p, selectedSchema: p.selectedSchema === schemaName ? '' : schemaName }));
  }, []);

  const handleAiCompare = useCallback(() => {
    if (!srcPane.serverId || !tgtPane.serverId) return;
    setAiResult(null);
    setAiRunning(true);
    setDiffViewActive(false);
    setAiProgress('Initialising MCP connection…');
    postMsg({ type: 'compareSchemasMcp', payload: {
      sourceServerId: srcPane.serverId,
      targetServerId: tgtPane.serverId,
      schema: srcPane.selectedSchema || 'public',
      objectTypes: ['table', 'view', 'function', 'sequence'],
    }});
  }, [srcPane, tgtPane]);

  const handleSrcLeafToggle = useCallback((id: string) => {
    setSrcLeafSel(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  const handleTgtLeafToggle = useCallback((id: string) => {
    setTgtLeafSel(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  const handleSrcGroupToggle = useCallback((leafIds: string[], allChecked: boolean) => {
    setSrcLeafSel(prev => {
      const next = new Set(prev);
      if (allChecked) leafIds.forEach(id => next.delete(id)); else leafIds.forEach(id => next.add(id));
      return next;
    });
  }, []);

  const handleTgtGroupToggle = useCallback((leafIds: string[], allChecked: boolean) => {
    setTgtLeafSel(prev => {
      const next = new Set(prev);
      if (allChecked) leafIds.forEach(id => next.delete(id)); else leafIds.forEach(id => next.add(id));
      return next;
    });
  }, []);

  const handleStartAgain = useCallback(() => {
    setSrcPane(emptyPane());
    setTgtPane(emptyPane());
    setAiResult(null);
    setAiRunning(false);
    setAiProgress('');
    setSrcLeafSel(new Set());
    setTgtLeafSel(new Set());
    setDiffPairs([]);
    setDiffViewActive(false);
    setDriftResult(null);
    setDriftScheduled(false);
    setDiffExplanation(null);
  }, []);

  const handleScheduleDrift = useCallback(() => {
    if (!srcPane.serverId || !tgtPane.serverId) return;
    setDriftScheduling(true);
    setDriftResult(null);
    setDriftProgress('Scheduling drift check…');
    postMsg({ type: 'scheduleDriftCheck', payload: {
      sourceServerId: srcPane.serverId,
      targetServerId: tgtPane.serverId,
      schema: srcPane.selectedSchema || 'public',
    }});
  }, [srcPane, tgtPane]);

  const handleExplainDiff = useCallback(() => {
    if (!aiResult?.data) return;
    setExplainRunning(true);
    setDiffExplanation(null);
    postMsg({ type: 'explainDiff', payload: {
      diffData: aiResult.data,
      sourceServerId: srcPane.serverId,
      targetServerId: tgtPane.serverId,
      schema: srcPane.selectedSchema || 'public',
    }});
  }, [aiResult, srcPane, tgtPane]);

  const handleDiffView = useCallback(() => {
    const items = [...srcLeafSel].map(id => {
      const [schema, type, name] = id.split('|');
      return { schema, type, name };
    });
    setDiffPairs([]);
    setDiffLoading(true);
    setDiffViewActive(true);
    setAiResult(null);
    postMsg({ type: 'fetchDdlPairs', payload: { sourceServerId: srcPane.serverId, targetServerId: tgtPane.serverId, items } });
  }, [srcLeafSel, srcPane.serverId, tgtPane.serverId]);

  // ── Render ───────────────────────────────────────────────────────
  if (!visible) return null;

  return (
    <div className="sdiff-page">
      <div className="sdiff-hd">
        <h1 className="sdiff-title">Schema Diff</h1>
        <span className="sdiff-badge">AI · MCP</span>
        <span className="sdiff-pill">PostgreSQL</span>
      </div>
      <AiDiffPanel
        allServers={allServers}
        srcPane={srcPane}
        tgtPane={tgtPane}
        onServerSelect={handlePaneServerSelect}
        onSchemaToggle={handleSchemaToggle}
        onSchemaSelect={handleSchemaSelect}
        running={aiRunning}
        progress={aiProgress}
        result={aiResult}
        onCompare={handleAiCompare}
        onStartAgain={handleStartAgain}
        srcLeafSel={srcLeafSel}
        tgtLeafSel={tgtLeafSel}
        onSrcLeafToggle={handleSrcLeafToggle}
        onTgtLeafToggle={handleTgtLeafToggle}
        onSrcGroupToggle={handleSrcGroupToggle}
        onTgtGroupToggle={handleTgtGroupToggle}
        diffLoading={diffLoading}
        diffPairs={diffPairs}
        diffViewActive={diffViewActive}
        onDiffView={handleDiffView}
        onCloseDiffView={() => { setDiffViewActive(false); setDiffPairs([]); }}
        driftScheduling={driftScheduling}
        driftScheduled={driftScheduled}
        driftProgress={driftProgress}
        driftResult={driftResult}
        onScheduleDrift={handleScheduleDrift}
        explainRunning={explainRunning}
        diffExplanation={diffExplanation}
        onExplainDiff={handleExplainDiff}
      />
    </div>
  );
}

/* ─── AI Diff Panel — two-pane MCP tree ─────────────────────────── */
interface AiDiffPanelProps {
  allServers:      { id: string; name: string; connAvailable: boolean }[];
  srcPane:         McpPane;
  tgtPane:         McpPane;
  onServerSelect:  (side: 'src' | 'tgt', id: string) => void;
  onSchemaToggle:  (side: 'src' | 'tgt', schema: string) => void;
  onSchemaSelect:  (side: 'src' | 'tgt', schema: string) => void;
  running:         boolean;
  progress:        string;
  result:          SchemaMcpResult | null;
  onCompare:       () => void;
  onStartAgain:    () => void;
  srcLeafSel:       Set<string>;
  tgtLeafSel:       Set<string>;
  onSrcLeafToggle:  (id: string) => void;
  onTgtLeafToggle:  (id: string) => void;
  onSrcGroupToggle: (leafIds: string[], allChecked: boolean) => void;
  onTgtGroupToggle: (leafIds: string[], allChecked: boolean) => void;
  diffLoading:      boolean;
  diffPairs:        DdlPair[];
  diffViewActive:   boolean;
  onDiffView:       () => void;
  onCloseDiffView:  () => void;
  // D18.10
  driftScheduling:  boolean;
  driftScheduled:   boolean;
  driftProgress:    string;
  driftResult:      Record<string, unknown> | null;
  onScheduleDrift:  () => void;
  // D19.2
  explainRunning:   boolean;
  diffExplanation:  string | null;
  onExplainDiff:    () => void;
}

function AiDiffPanel({ allServers, srcPane, tgtPane, onServerSelect, onSchemaToggle, onSchemaSelect, running, progress, result, onCompare, onStartAgain, srcLeafSel, tgtLeafSel, onSrcLeafToggle, onTgtLeafToggle, onSrcGroupToggle, onTgtGroupToggle, diffLoading, diffPairs, diffViewActive, onDiffView, onCloseDiffView, driftScheduling, driftScheduled, driftProgress, driftResult, onScheduleDrift, explainRunning, diffExplanation, onExplainDiff }: AiDiffPanelProps) {
  const [showExplainPopup, setShowExplainPopup] = useState(false);
  const [showDriftPopup, setShowDriftPopup] = useState(false);

  // Use refs initialized to current prop values so useEffect only fires when
  // data genuinely arrives NEW — not on remount with already-present data.
  const prevExplainRef = useRef(diffExplanation);
  const prevDriftRef   = useRef(driftResult);

  useEffect(() => {
    if (diffExplanation && diffExplanation !== prevExplainRef.current) setShowExplainPopup(true);
    prevExplainRef.current = diffExplanation;
  }, [diffExplanation]);

  useEffect(() => {
    if (driftResult && !driftResult.error && driftResult !== prevDriftRef.current) setShowDriftPopup(true);
    prevDriftRef.current = driftResult;
  }, [driftResult]);

  const canCompare = !!srcPane.serverId && !!tgtPane.serverId
    && srcPane.serverId !== tgtPane.serverId
    && !!srcPane.selectedSchema && !!tgtPane.selectedSchema;

  const hasAnyState = !!srcPane.serverId || !!tgtPane.serverId || !!result;
  const srcSchema = srcPane.selectedSchema;
  const tgtSchema = tgtPane.selectedSchema || srcPane.selectedSchema;

  return (
    <div className="sdiff-ai-panel">
      {/* Header */}
      <div className="sdiff-ai-intro">
        <div className="sdiff-ai-intro-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
          </svg>
        </div>
        <div className="sdiff-ai-intro-main">
          <div className="sdiff-ai-intro-title">AI Schema Comparison via MCP</div>
          <div className="sdiff-ai-intro-text">Pick a <b>Source</b> and <b>Target</b> database, select a schema in each tree, then compare.</div>
        </div>
        {hasAnyState && (
          <button type="button" className="sdiff-start-again-btn" onClick={onStartAgain} title="Reset and start over">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
            </svg>
            Start Again
          </button>
        )}
      </div>

      {allServers.length === 0 ? (
        <div className="sdiff-ai-no-servers">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          No MCP servers configured. Add servers in <b>Settings → MCP Servers</b>.
        </div>
      ) : (
        <div className="sdiff-ai-two-pane">
          <McpTreePane
            side="src"
            label="Source"
            servers={allServers}
            pane={srcPane}
            otherServerId={tgtPane.serverId}
            onServerSelect={id => onServerSelect('src', id)}
            onSchemaToggle={name => onSchemaToggle('src', name)}
            onSchemaSelect={name => onSchemaSelect('src', name)}
            leafSel={srcLeafSel}
            onLeafToggle={onSrcLeafToggle}
            onGroupToggle={onSrcGroupToggle}
          />
          <div className="sdiff-ai-pane-sep">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
          </div>
          <McpTreePane
            side="tgt"
            label="Target"
            servers={allServers}
            pane={tgtPane}
            otherServerId={srcPane.serverId}
            onServerSelect={id => onServerSelect('tgt', id)}
            onSchemaToggle={name => onSchemaToggle('tgt', name)}
            onSchemaSelect={name => onSchemaSelect('tgt', name)}
            leafSel={tgtLeafSel}
            onLeafToggle={onTgtLeafToggle}
            onGroupToggle={onTgtGroupToggle}
          />
        </div>
      )}

      {/* Compare action bar */}
      <div className="sdiff-actions">
        {/* Left: comparing chips */}
        <div className="sdiff-comparing-chips">
          {srcSchema && tgtPane.serverId && (
            <>
              <span className="sdiff-chip sdiff-chip--src">{srcSchema}</span>
              <span className="sdiff-chip-arrow">↔</span>
              <span className="sdiff-chip sdiff-chip--tgt">{tgtSchema}</span>
            </>
          )}
        </div>

        {/* Right: action buttons */}
        <div className="sdiff-action-btns">
          <button
            type="button"
            className="sdiff-btn secondary"
            onClick={onDiffView}
            disabled={diffLoading || srcLeafSel.size === 0}
            title={srcLeafSel.size === 0 ? 'Check objects in Source tree to diff' : ''}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/>
            </svg>
            {diffLoading ? 'Loading…' : 'Diff View'}
          </button>
          {/* D18.10 — Schedule Drift Check */}
          <button
            type="button"
            className="sdiff-btn secondary"
            onClick={onScheduleDrift}
            disabled={driftScheduling || !srcPane.serverId || !tgtPane.serverId}
            title={!srcPane.serverId || !tgtPane.serverId ? 'Select Source and Target servers first' : driftScheduled ? 'Drift check scheduled — running now' : 'Schedule background drift detection'}
            style={{ color: driftScheduled ? '#f97316' : undefined, borderColor: driftScheduled ? 'rgba(249,115,22,0.4)' : undefined }}
          >
            {driftScheduling
              ? <><span className="sdiff-ai-spinner" style={{ width: 10, height: 10, borderTopColor: '#f97316' }} /> Checking…</>
              : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> {driftScheduled ? 'Drift Scheduled ✓' : '↺ Drift Check'}</>
            }
          </button>
          {/* Explain Diff */}
          {result?.ok && (
            <button
              type="button"
              className="sdiff-btn secondary"
              onClick={() => { if (diffExplanation) { setShowExplainPopup(true); return; } onExplainDiff(); }}
              disabled={explainRunning}
              title="AI explains why these environments diverged"
              style={{ color: diffExplanation ? '#a5b4fc' : '#818cf8', borderColor: diffExplanation ? 'rgba(165,180,252,0.45)' : 'rgba(129,140,248,0.35)' }}
            >
              {explainRunning
                ? <><span className="sdiff-ai-spinner" style={{ width: 10, height: 10, borderTopColor: '#818cf8' }} /> Explaining…</>
                : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Explain Diff</>
              }
            </button>
          )}
          {/* Drift Detective re-open */}
          {driftResult && !driftResult.error && (
            <button
              type="button"
              className="sdiff-btn secondary"
              onClick={() => setShowDriftPopup(true)}
              title="View drift detection result"
              style={{ color: '#f97316', borderColor: 'rgba(249,115,22,0.4)' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Drift Result
            </button>
          )}
          <button
            type="button"
            className="sdiff-btn accent"
            onClick={onCompare}
            disabled={running || !canCompare}
            title={!canCompare ? (!srcPane.serverId || !tgtPane.serverId ? 'Select Source and Target servers' : (!srcPane.selectedSchema || !tgtPane.selectedSchema ? 'Select a schema in both panes' : 'Servers must differ')) : ''}
          >
            {running
              ? 'Comparing…'
              : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Compare schemas</>
            }
          </button>
        </div>
      </div>

      {/* Progress bar (unchanged — keeps its own spinner) */}
      {running && progress && (
        <div className="sdiff-ai-progress">
          <span className="sdiff-ai-spinner" />
          <span>{progress}</span>
        </div>
      )}

      {result && <AiDiffResult result={result} />}

      {/* Drift Detective progress */}
      {(driftScheduling || driftProgress) && (
        <div className="sdiff-ai-progress" style={{ borderColor: 'rgba(249,115,22,0.2)', background: 'rgba(249,115,22,0.05)' }}>
          <span className="sdiff-ai-spinner" style={{ borderTopColor: '#f97316' }} />
          <span style={{ color: '#fb923c' }}>{driftProgress || 'Running drift check…'}</span>
        </div>
      )}
      {driftResult?.error !== undefined && (
        <div className="sdiff-ai-error"><span>Drift check error: {String(driftResult.error as string)}</span></div>
      )}

      {/* AI Diff Explanation popup */}
      {diffExplanation && (
        <ModalView
          open={showExplainPopup}
          onClose={() => setShowExplainPopup(false)}
          title="AI Diff Explanation"
          headerColor="#818cf8"
          size="lg"
        >
          <MarkdownView content={diffExplanation} />
        </ModalView>
      )}

      {/* Drift Detective popup */}
      {driftResult && !driftResult.error && (
        <ModalView
          open={showDriftPopup}
          onClose={() => setShowDriftPopup(false)}
          title="Drift Detective"
          headerColor="#f97316"
          size="md"
        >
          <DriftDetectiveResult result={driftResult} />
        </ModalView>
      )}

      {/* Monaco Diff View — modal overlay */}
      {diffViewActive && (
        <div className="sdiff-diff-modal-overlay" onClick={e => { if (e.target === e.currentTarget) onCloseDiffView(); }}>
          <div className="sdiff-diff-modal-inner">
            {diffLoading ? (
              <div className="sdiff-ai-progress" style={{ margin: 20 }}>
                <span className="sdiff-ai-spinner" />
                <span>Fetching DDL from both databases…</span>
              </div>
            ) : (
              <MonacoDiffView pairs={diffPairs} onClose={onCloseDiffView} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── MCP Tree Pane ──────────────────────────────────────────────── */
interface McpTreePaneProps {
  side:          'src' | 'tgt';
  label:         string;
  servers:       { id: string; name: string; connAvailable: boolean }[];
  pane:          McpPane;
  otherServerId: string;
  onServerSelect:(id: string) => void;
  onSchemaToggle:(name: string) => void;
  onSchemaSelect:(name: string) => void;
  leafSel:        Set<string>;
  onLeafToggle:   (id: string) => void;
  onGroupToggle:  (leafIds: string[], allChecked: boolean) => void;
}

function McpTreePane({ side, label, servers, pane, otherServerId, onServerSelect, onSchemaToggle, onSchemaSelect, leafSel, onLeafToggle, onGroupToggle }: McpTreePaneProps) {
  const accentColor = side === 'src' ? '#818cf8' : '#f97316';

  // Build StyledDropdown items (filter out otherServerId, add blank placeholder)
  const serverItems = [
    { value: '', label: '— select database —' },
    ...servers.filter(s => s.id !== otherServerId).map(s => ({ value: s.id, label: s.name })),
  ];

  return (
    <div className={`sdiff-mcp-pane sdiff-mcp-pane--${side}`}>
      {/* Pane header */}
      <div className="sdiff-mcp-pane-hd" style={{ borderBottomColor: accentColor + '44' }}>
        <span className="sdiff-mcp-pane-dot" style={{ background: accentColor }} />
        <span className="sdiff-mcp-pane-label" style={{ color: accentColor }}>{label}</span>
        {pane.selectedSchema && (
          <span className="sdiff-mcp-pane-sel-badge" style={{ color: accentColor, borderColor: accentColor + '55' }}>
            {pane.selectedSchema}
          </span>
        )}
      </div>

      {/* Server select — replaced with StyledDropdown (#3) */}
      <div className="sdiff-mcp-server-dd">
        <StyledDropdown
          items={serverItems}
          value={pane.serverId}
          onChange={onServerSelect}
        />
      </div>

      {/* Tree area */}
      <div className="sdiff-mcp-tree">
        {!pane.serverId && (
          <div className="sdiff-mcp-empty">Select a database above</div>
        )}
        {pane.serverId && pane.loading && (
          <div className="sdiff-mcp-loading">
            <span className="sdiff-ai-spinner" style={{ borderTopColor: accentColor }} />
            Loading schemas…
          </div>
        )}
        {pane.serverId && !pane.loading && pane.schemas.length === 0 && (
          <div className="sdiff-mcp-empty">No schemas found</div>
        )}
        {pane.schemas.map(schema => (
          <SchemaTreeRow
            key={schema.name}
            schema={schema}
            selected={pane.selectedSchema === schema.name}
            accentColor={accentColor}
            onToggle={() => onSchemaToggle(schema.name)}
            onSelect={() => onSchemaSelect(schema.name)}
            leafSel={leafSel}
            onLeafToggle={onLeafToggle}
            onGroupToggle={onGroupToggle}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── Schema tree row ────────────────────────────────────────────── */
function SchemaTreeRow({ schema, selected, accentColor, onToggle, onSelect, leafSel, onLeafToggle, onGroupToggle }: {
  schema: McpSchemaInfo;
  selected: boolean;
  accentColor: string;
  onToggle: () => void;
  onSelect: () => void;
  leafSel: Set<string>;
  onLeafToggle: (id: string) => void;
  onGroupToggle: (leafIds: string[], allChecked: boolean) => void;
}) {
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>({});

  const totalObjects = schema.tables.length + schema.views.length + schema.functions.length + schema.sequences.length;

  const handleRowClick = () => {
    onToggle();
    onSelect();
  };

  const toggleGroup = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setGroupExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className={`sdiff-mcp-schema${selected ? ' is-selected' : ''}`}
      style={selected ? { borderLeftColor: accentColor, background: accentColor + '12' } : undefined}>
      {/* Schema row */}
      <div className="sdiff-mcp-schema-row" onClick={handleRowClick}>
        <svg className={`sdiff-mcp-chevron${schema.expanded ? ' open' : ''}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {/* Schema selection checkbox */}
        <div
          className={`sdiff-schema-cb${selected ? ' checked' : ''}`}
          style={selected ? { borderColor: accentColor, background: accentColor } : { borderColor: 'rgba(255,255,255,0.18)' }}
        >
          {selected && (
            <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 6 5 9 10 3"/>
            </svg>
          )}
        </div>
        <svg className="sdiff-mcp-schema-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={selected ? accentColor : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9"/>
        </svg>
        <span className="sdiff-mcp-schema-name" style={selected ? { color: accentColor, fontWeight: 700 } : undefined}>{schema.name}</span>
        {schema.loaded && totalObjects > 0 && (
          <span className="sdiff-mcp-obj-count">{totalObjects}</span>
        )}
        {schema.loading && <span className="sdiff-ai-spinner" style={{ width: 9, height: 9, borderTopColor: accentColor }} />}
      </div>

      {/* Children */}
      {schema.expanded && (
        <div className="sdiff-mcp-schema-children">
          {schema.loading && <div className="sdiff-mcp-loading-sm"><span className="sdiff-ai-spinner" style={{ width: 9, height: 9 }} />Loading objects…</div>}
          {schema.loaded && schema.tables.length === 0 && schema.views.length === 0 && schema.functions.length === 0 && schema.sequences.length === 0 && (
            <div className="sdiff-mcp-empty-sm">No objects found</div>
          )}
          {schema.loaded && (
            <>
              {schema.tables.length > 0 && (
                <ObjectGroupRow type="table" label="Tables" schemaName={schema.name} items={schema.tables} expanded={!!groupExpanded['table']} onToggle={e => toggleGroup('table', e)} leafSel={leafSel} onLeafToggle={onLeafToggle} onGroupToggle={onGroupToggle} />
              )}
              {schema.views.length > 0 && (
                <ObjectGroupRow type="view" label="Views" schemaName={schema.name} items={schema.views} expanded={!!groupExpanded['view']} onToggle={e => toggleGroup('view', e)} leafSel={leafSel} onLeafToggle={onLeafToggle} onGroupToggle={onGroupToggle} />
              )}
              {schema.functions.length > 0 && (
                <ObjectGroupRow type="function" label="Functions" schemaName={schema.name} items={schema.functions} expanded={!!groupExpanded['function']} onToggle={e => toggleGroup('function', e)} leafSel={leafSel} onLeafToggle={onLeafToggle} onGroupToggle={onGroupToggle} />
              )}
              {schema.sequences.length > 0 && (
                <ObjectGroupRow type="sequence" label="Sequences" schemaName={schema.name} items={schema.sequences} expanded={!!groupExpanded['sequence']} onToggle={e => toggleGroup('sequence', e)} leafSel={leafSel} onLeafToggle={onLeafToggle} onGroupToggle={onGroupToggle} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Object group row ───────────────────────────────────────────── */
type ObjType = 'table' | 'view' | 'function' | 'sequence';

const OBJ_ICONS: Record<ObjType, string> = { table: '▤', view: '◫', function: 'ƒ', sequence: '#' };
const OBJ_COLORS: Record<ObjType, string> = { table: '#818cf8', view: '#34d399', function: '#f59e0b', sequence: '#94a3b8' };

function ObjectGroupRow({ type, label, schemaName, items, expanded, onToggle, leafSel, onLeafToggle, onGroupToggle }: {
  type: ObjType;
  label: string;
  schemaName: string;
  items: string[];
  expanded: boolean;
  onToggle: (e: React.MouseEvent) => void;
  leafSel: Set<string>;
  onLeafToggle: (id: string) => void;
  onGroupToggle: (leafIds: string[], allChecked: boolean) => void;
}) {
  const allLeafIds = items.map(name => `${schemaName}|${type}|${name}`);
  const checkedCount = allLeafIds.filter(id => leafSel.has(id)).length;
  const allChecked = checkedCount === items.length && items.length > 0;
  const someChecked = checkedCount > 0 && checkedCount < items.length;

  return (
    <div className="sdiff-mcp-group">
      <div className="sdiff-mcp-group-row" onClick={onToggle}>
        {/* Group-level checkbox — select all / deselect all */}
        <div
          className={`sdiff-mcp-cb${allChecked ? ' checked' : someChecked ? ' partial' : ''}`}
          style={allChecked || someChecked ? { background: OBJ_COLORS[type], borderColor: OBJ_COLORS[type] } : { borderColor: OBJ_COLORS[type] + '55' }}
          onClick={e => { e.stopPropagation(); onGroupToggle(allLeafIds, allChecked); }}
        >
          {allChecked && (
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2 6 5 9 10 3"/>
            </svg>
          )}
          {someChecked && (
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="2" y1="6" x2="10" y2="6"/>
            </svg>
          )}
        </div>
        <svg className={`sdiff-mcp-chevron sm${expanded ? ' open' : ''}`} width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <span className="sdiff-mcp-group-icon" style={{ color: OBJ_COLORS[type] }}>{OBJ_ICONS[type]}</span>
        <span className="sdiff-mcp-group-label">{label}</span>
        <span className="sdiff-mcp-group-count">{items.length}</span>
      </div>
      {expanded && (
        <div className="sdiff-mcp-obj-list">
          {items.map(name => {
            const leafId = `${schemaName}|${type}|${name}`;
            const checked = leafSel.has(leafId);
            return (
              <div key={name} className="sdiff-mcp-obj-item" onClick={e => { e.stopPropagation(); onLeafToggle(leafId); }}>
                {/* Custom checkbox (#2) */}
                <div
                  className={`sdiff-mcp-cb${checked ? ' checked' : ''}`}
                  style={checked ? { background: OBJ_COLORS[type], borderColor: OBJ_COLORS[type] } : { borderColor: OBJ_COLORS[type] + '66' }}
                >
                  {checked && (
                    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="2 6 5 9 10 3"/>
                    </svg>
                  )}
                </div>
                <span className="sdiff-mcp-obj-dot" style={{ background: OBJ_COLORS[type] }} />
                <span className="sdiff-mcp-obj-name">{name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── AI Diff Result ─────────────────────────────────────────────── */
function AiDiffResult({ result }: { result: SchemaMcpResult }) {
  if (!result.ok) {
    return (
      <div className="sdiff-ai-error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>{result.error || 'Comparison failed'}</span>
      </div>
    );
  }

  const raw = result.data as Record<string, unknown> | null;
  if (!raw) return null;

  return <SchemaDriftReport data={raw} aiAnalysis={result.aiAnalysis ?? null} />;
}

/* ─── Schema Drift Report (DUI-inspired design) ──────────────────── */
type DriftObject = { name: string; type?: string; schema?: string; left_ddl?: string; right_ddl?: string };

/* ─── LCS diff (reuse same engine as D3.3) ──────────────────────────────── */
type DiffLine = { type: 'add' | 'del' | 'eq'; text: string };

function lcsLineDiff(srcLines: string[], tgtLines: string[]): DiffLine[] {
  const m = srcLines.length, n = tgtLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = srcLines[i - 1] === tgtLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && srcLines[i - 1] === tgtLines[j - 1]) { result.push({ type: 'eq',  text: srcLines[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { result.push({ type: 'add', text: tgtLines[j - 1] }); j--; }
    else { result.push({ type: 'del', text: srcLines[i - 1] }); i--; }
  }
  return result.reverse();
}

/* ─── SchemaNodeGraph (D11.5) ───────────────────────────────────────────── */
type NodeStatus = 'missing' | 'extra' | 'drift' | 'sync';

interface GraphNode {
  id: string;
  name: string;
  type: string;
  schema: string;
  status: NodeStatus;
  left_ddl?: string;
  right_ddl?: string;
}

const NODE_COLOR: Record<NodeStatus, string> = {
  missing: '#ef4444',
  extra:   '#f97316',
  drift:   '#eab308',
  sync:    '#4ade80',
};
const NODE_LABEL: Record<NodeStatus, string> = {
  missing: 'Missing from target',
  extra:   'Extra in target',
  drift:   'DDL drifted',
  sync:    'In sync',
};

function SchemaNodeGraph({ data }: { data: Record<string, unknown> }) {
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const onlyInSrc = (data['only_in_source'] as DriftObject[] | undefined) ?? [];
  const onlyInTgt = (data['only_in_target'] as DriftObject[] | undefined) ?? [];
  const driftedR  = (data['drifted']         as DriftObject[] | undefined) ?? [];
  const inSyncR   = (data['in_sync']         as DriftObject[] | undefined) ?? [];

  const nodes: GraphNode[] = [
    ...onlyInSrc.map(o => ({ id: `src_${o.schema}_${o.name}`, name: o.name, type: o.type ?? 'object', schema: o.schema ?? '', status: 'missing' as NodeStatus, left_ddl: o.left_ddl, right_ddl: o.right_ddl })),
    ...onlyInTgt.map(o => ({ id: `tgt_${o.schema}_${o.name}`, name: o.name, type: o.type ?? 'object', schema: o.schema ?? '', status: 'extra'   as NodeStatus, left_ddl: o.left_ddl, right_ddl: o.right_ddl })),
    ...driftedR.map(o  => ({ id: `dft_${o.schema}_${o.name}`, name: o.name, type: o.type ?? 'object', schema: o.schema ?? '', status: 'drift'   as NodeStatus, left_ddl: o.left_ddl, right_ddl: o.right_ddl })),
    ...inSyncR.map(o   => ({ id: `syn_${o.schema}_${o.name}`, name: o.name, type: o.type ?? 'object', schema: o.schema ?? '', status: 'sync'    as NodeStatus, left_ddl: o.left_ddl, right_ddl: o.right_ddl })),
  ];

  const allTypes = Array.from(new Set(nodes.map(n => n.type)));
  const filtered = typeFilter === 'all' ? nodes : nodes.filter(n => n.type === typeFilter);

  /* Layout: group by status, arrange in rows of 4 */
  const ROW_W = 4;
  const NODE_W = 130, NODE_H = 52, GAP_X = 16, GAP_Y = 14;
  const SECTION_GAP = 28;

  type Section = { status: NodeStatus; nodes: GraphNode[]; y: number };
  const sections: Section[] = [];
  let curY = 16;
  for (const status of ['missing', 'extra', 'drift', 'sync'] as NodeStatus[]) {
    const grp = filtered.filter(n => n.status === status);
    if (grp.length === 0) continue;
    sections.push({ status, nodes: grp, y: curY });
    const rows = Math.ceil(grp.length / ROW_W);
    curY += rows * (NODE_H + GAP_Y) + SECTION_GAP + 24;
  }

  const svgW = ROW_W * (NODE_W + GAP_X) - GAP_X + 32;
  const svgH = curY;

  const diffLines: DiffLine[] = selected
    ? lcsLineDiff(
        (selected.left_ddl ?? '').split('\n'),
        (selected.right_ddl ?? '').split('\n'),
      )
    : [];

  return (
    <div style={{ width: '100%' }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>Filter:</span>
        {['all', ...allTypes].map(t => (
          <button key={t} onClick={() => setTypeFilter(t)} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 4, border: '1px solid', cursor: 'pointer', borderColor: typeFilter === t ? '#818cf8' : 'rgba(255,255,255,0.12)', background: typeFilter === t ? 'rgba(99,102,241,0.15)' : 'none', color: typeFilter === t ? '#818cf8' : '#94a3b8' }}>
            {t}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
          {(['missing', 'extra', 'drift', 'sync'] as NodeStatus[]).map(s => (
            <span key={s} style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, color: '#64748b' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: NODE_COLOR[s], display: 'inline-block' }} />{NODE_LABEL[s]}
            </span>
          ))}
        </div>
      </div>

      {/* SVG node graph */}
      <div style={{ overflowX: 'auto', background: 'var(--bg-secondary, rgba(255,255,255,0.02))', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
          {sections.map(sec => {
            const color = NODE_COLOR[sec.status];
            return (
              <g key={sec.status}>
                {/* Section label */}
                <text x={16} y={sec.y + 12} fontSize={10} fontWeight={700} fill={color} letterSpacing="0.06em">{NODE_LABEL[sec.status].toUpperCase()} ({sec.nodes.length})</text>
                {/* Nodes */}
                {sec.nodes.map((node, idx) => {
                  const col = idx % ROW_W;
                  const row = Math.floor(idx / ROW_W);
                  const nx = 16 + col * (NODE_W + GAP_X);
                  const ny = sec.y + 22 + row * (NODE_H + GAP_Y);
                  const isSelected = selected?.id === node.id;
                  return (
                    <g key={node.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(isSelected ? null : node)}>
                      <rect
                        x={nx} y={ny} width={NODE_W} height={NODE_H} rx={7}
                        fill={isSelected ? color + '30' : color + '12'}
                        stroke={isSelected ? color : color + '50'}
                        strokeWidth={isSelected ? 1.8 : 1}
                      />
                      {/* Type badge */}
                      <rect x={nx + 6} y={ny + 6} width={28} height={14} rx={3} fill={color + '30'} />
                      <text x={nx + 20} y={ny + 17} fontSize={9} fontWeight={700} fill={color} textAnchor="middle" letterSpacing="0.03em">
                        {node.type.slice(0, 4).toUpperCase()}
                      </text>
                      {/* Object name */}
                      <text x={nx + 40} y={ny + 17} fontSize={11} fontWeight={600} fill="var(--vscode-foreground, #e2e8f0)">
                        {node.name.slice(0, 14)}{node.name.length > 14 ? '…' : ''}
                      </text>
                      {/* Schema */}
                      {node.schema && (
                        <text x={nx + 6} y={ny + 37} fontSize={9.5} fill="#475569">
                          {node.schema.slice(0, 18)}
                        </text>
                      )}
                      {/* Expand indicator when selected */}
                      {isSelected && (
                        <circle cx={nx + NODE_W - 10} cy={ny + NODE_H - 10} r={4} fill={color} />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      {/* DDL Diff panel for selected node */}
      {selected && (
        <div style={{ marginTop: 14, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: NODE_COLOR[selected.status], flexShrink: 0, display: 'inline-block' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--vscode-foreground, #e2e8f0)' }}>
              {selected.schema ? <span style={{ color: '#64748b' }}>{selected.schema}.</span> : null}{selected.name}
            </span>
            <span style={{ fontSize: 10, color: NODE_COLOR[selected.status], background: NODE_COLOR[selected.status] + '18', padding: '2px 6px', borderRadius: 3 }}>
              {NODE_LABEL[selected.status]}
            </span>
            <button onClick={() => setSelected(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 16 }}>×</button>
          </div>
          {(selected.left_ddl || selected.right_ddl) ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
              {(['left', 'right'] as const).map(side => {
                const ddl = side === 'left' ? selected.left_ddl : selected.right_ddl;
                const label = side === 'left' ? 'Source (ST)' : 'Target (PROD)';
                const lines = (ddl ?? '').split('\n');
                const diffMap: Record<number, DiffLine['type']> = {};
                let si = 0, ti = 0;
                diffLines.forEach(dl => {
                  if (dl.type === 'eq')  { if (side === 'left')  diffMap[si++] = 'eq';  if (side === 'right') diffMap[ti++] = 'eq';  }
                  if (dl.type === 'del') { if (side === 'left')  diffMap[si++] = 'del'; }
                  if (dl.type === 'add') { if (side === 'right') diffMap[ti++] = 'add'; }
                });
                return (
                  <div key={side} style={{ borderRight: side === 'left' ? '1px solid rgba(255,255,255,0.06)' : undefined }}>
                    <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 600, color: side === 'left' ? '#60a5fa' : '#fb923c', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>{label}</div>
                    <pre style={{ margin: 0, padding: '8px 0', maxHeight: 300, overflowY: 'auto', fontSize: 11, fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre' }}>
                      {ddl ? lines.map((line, li) => {
                        const dtype = diffMap[li];
                        const bg = dtype === 'del' ? 'rgba(239,68,68,0.15)' : dtype === 'add' ? 'rgba(74,222,128,0.12)' : 'transparent';
                        const color = dtype === 'del' ? '#f87171' : dtype === 'add' ? '#4ade80' : '#94a3b8';
                        return (
                          <span key={li} style={{ display: 'block', background: bg, color, paddingLeft: 8 }}>
                            {dtype === 'del' ? '− ' : dtype === 'add' ? '+ ' : '  '}{line}
                          </span>
                        );
                      }) : <span style={{ color: '#475569', paddingLeft: 8 }}>— not present in {side === 'left' ? 'source' : 'target'}</span>}
                    </pre>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: '12px 14px', fontSize: 11.5, color: '#64748b' }}>
              No DDL available for this object. Run with <code>object_types</code> that includes DDL.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TYPE_ORDER = ['table', 'view', 'function', 'sequence', 'object'];
const TYPE_LABEL: Record<string, string> = { table: 'Tables', view: 'Views', function: 'Functions', sequence: 'Sequences', object: 'Objects' };
const TYPE_SIGIL: Record<string, string> = { table: '▤', view: '◫', function: 'ƒ', sequence: '#', object: '•' };
const TYPE_BADGE: Record<string, string> = { table: 'TABL', view: 'VIEW', function: 'FUNC', sequence: 'SEQU', object: 'OBJ' };

function SchemaDriftReport({ data, aiAnalysis }: { data: Record<string, unknown>; aiAnalysis: DriftAnalysis | null | undefined }) {
  const [expandedDdl, setExpandedDdl]         = useState<Set<string>>(new Set());
  const [sectionCollapsed, setSectionCollapsed] = useState<Record<string, boolean>>({});
  const [groupCollapsed, setGroupCollapsed]     = useState<Record<string, boolean>>({});
  const [rawVisible, setRawVisible]             = useState(false);
  const [graphView, setGraphView]               = useState(false);

  function handleExportReport() {
    const onlyInSrcL  = (data['only_in_source'] as DriftObject[] | undefined) ?? [];
    const onlyInTgtL  = (data['only_in_target'] as DriftObject[] | undefined) ?? [];
    const driftedL    = (data['drifted']         as DriftObject[] | undefined) ?? [];
    const summ        = data['summary'] as { only_in_source?: number; only_in_target?: number; drifted?: number; in_sync?: number } | undefined;
    const lines: string[] = [
      `# Schema Drift Report`,
      `> Generated: ${new Date().toLocaleString()}`,
      '',
      '## Summary',
      `| Category | Count |`,
      `|----------|-------|`,
      `| Missing from Target | ${summ?.only_in_source ?? onlyInSrcL.length} |`,
      `| Extra in Target     | ${summ?.only_in_target ?? onlyInTgtL.length} |`,
      `| DDL Drift           | ${summ?.drifted         ?? driftedL.length} |`,
      `| In Sync             | ${summ?.in_sync         ?? 0} |`,
      '',
    ];
    if (aiAnalysis) {
      lines.push('## AI Analysis');
      if (aiAnalysis.riskLevel)      lines.push(`**Risk**: ${aiAnalysis.riskLevel.toUpperCase()}`);
      if (aiAnalysis.headline)       lines.push(`**Headline**: ${aiAnalysis.headline}`);
      if (aiAnalysis.summary)        lines.push('', aiAnalysis.summary);
      if (aiAnalysis.migrationAdvice) lines.push('', '### Migration Advice', aiAnalysis.migrationAdvice);
      lines.push('');
    }
    if (onlyInSrcL.length > 0) {
      lines.push('## Missing from Target');
      for (const o of onlyInSrcL) lines.push(`- \`${o.schema}.${o.name}\` (${o.type})`);
      lines.push('');
    }
    if (onlyInTgtL.length > 0) {
      lines.push('## Extra in Target');
      for (const o of onlyInTgtL) lines.push(`- \`${o.schema}.${o.name}\` (${o.type})`);
      lines.push('');
    }
    if (driftedL.length > 0) {
      lines.push('## DDL Drift');
      for (const o of driftedL) {
        lines.push(`### \`${o.schema}.${o.name}\` (${o.type})`);
        if (o.left_ddl)  lines.push('**Source DDL:**', '```sql', o.left_ddl, '```');
        if (o.right_ddl) lines.push('**Target DDL:**', '```sql', o.right_ddl, '```');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `schema-drift-${new Date().toISOString().slice(0, 10)}.md`;
    a.click(); URL.revokeObjectURL(url);
  }

  function handleGenerateMigration() {
    const onlyInSrcL = (data['only_in_source'] as DriftObject[] | undefined) ?? [];
    const driftedL   = (data['drifted']         as DriftObject[] | undefined) ?? [];
    const lines: string[] = [
      '-- Schema Drift Migration',
      `-- Generated: ${new Date().toLocaleString()}`,
      '--',
      '-- Review and customize this SQL before running.',
      '--',
    ];
    for (const o of driftedL) {
      lines.push('', `-- DRIFTED: ${o.schema ?? 'public'}.${o.name} (${o.type}) — applying source version to target`);
      if (o.left_ddl) lines.push(o.left_ddl.trimEnd() + ';');
    }
    for (const o of onlyInSrcL) {
      lines.push('', `-- MISSING IN TARGET: ${o.schema ?? 'public'}.${o.name} (${o.type})`);
      if (o.left_ddl) lines.push(o.left_ddl.trimEnd() + ';');
    }
    lines.push('');
    const hint = `schema_drift_migration_${new Date().toISOString().slice(0,10).replace(/-/g,'_')}`;
    postMsg({ type: 'openFormWithPrefill', payload: { form: 'freeform', sql: lines.join('\n'), hint } });
  }

  const summary    = data['summary'] as { only_in_source?: number; only_in_target?: number; drifted?: number; in_sync?: number } | undefined;
  const onlyInSrc  = (data['only_in_source'] as DriftObject[] | undefined) ?? [];
  const onlyInTgt  = (data['only_in_target'] as DriftObject[] | undefined) ?? [];
  const drifted    = (data['drifted']         as DriftObject[] | undefined) ?? [];
  const inSync     = (data['in_sync']         as DriftObject[] | undefined) ?? [];
  const totalSrc   = summary?.only_in_source ?? onlyInSrc.length;
  const totalTgt   = summary?.only_in_target ?? onlyInTgt.length;
  const totalDrift = summary?.drifted         ?? drifted.length;
  const totalSync  = summary?.in_sync         ?? inSync.length;
  const isDiffFree = totalSrc === 0 && totalTgt === 0 && totalDrift === 0;

  const RISK_COLOR: Record<string, string> = { high: '#ef4444', medium: '#f97316', low: '#eab308', none: '#4ade80' };
  const RISK_BG:    Record<string, string> = { high: 'rgba(239,68,68,.12)', medium: 'rgba(249,115,22,.12)', low: 'rgba(234,179,8,.12)', none: 'rgba(74,222,128,.12)' };

  function toggleDdl(key: string) {
    setExpandedDdl(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleSection(key: string) {
    setSectionCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
  }
  function toggleTypeGroup(key: string) {
    setGroupCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
  }

  function groupByType(items: DriftObject[]) {
    const g: Record<string, DriftObject[]> = {};
    for (const o of items) { const t = (o.type ?? 'object').toLowerCase(); (g[t] ??= []).push(o); }
    return g;
  }

  function renderGrouped(sectionKey: string, items: DriftObject[], renderItem: (o: DriftObject, i: number) => React.ReactNode, useGrid = false) {
    const g = groupByType(items);
    const keys = [...TYPE_ORDER.filter(t => g[t]), ...Object.keys(g).filter(t => !TYPE_ORDER.includes(t))];
    return keys.map(t => {
      const gKey = `${sectionKey}_${t}`;
      const isCollapsed = !!groupCollapsed[gKey];
      return (
        <div key={t} className="sdiff-type-group">
          <button type="button" className="sdiff-type-hd" onClick={() => toggleTypeGroup(gKey)}>
            <span className={`sdiff-type-chevron${isCollapsed ? '' : ' open'}`}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </span>
            <span style={{ color: OBJ_COLORS[t as ObjType] ?? '#64748b', fontSize: 11 }}>{TYPE_SIGIL[t] ?? '•'}</span>
            <span>{TYPE_LABEL[t] ?? t}</span>
            <span className="sdiff-type-hd-ct">{g[t].length}</span>
          </button>
          {!isCollapsed && (
            useGrid
              ? <div className="sdiff-cards-grid">{g[t].map((o, i) => renderItem(o, i))}</div>
              : <>{g[t].map((o, i) => renderItem(o, i))}</>
          )}
        </div>
      );
    });
  }

  return (
    <div className="sdiff-report">

      {/* ── Stats row ── */}
      <div className="sdiff-stats-row">
        {([
          { label: 'Missing', hint: 'from target',  count: totalSrc,   color: totalSrc   > 0 ? '#ef4444' : '#334155' },
          { label: 'Extra',   hint: 'in target',    count: totalTgt,   color: totalTgt   > 0 ? '#f97316' : '#334155' },
          { label: 'Drifted', hint: 'DDL changed',  count: totalDrift, color: totalDrift > 0 ? '#eab308' : '#334155' },
          { label: 'In sync', hint: 'identical',    count: totalSync,  color: totalSync  > 0 ? '#4ade80' : '#334155' },
        ] as const).map(s => (
          <div key={s.label} className="sdiff-stat-card" style={{ borderColor: s.count > 0 ? s.color + '30' : undefined }}>
            <div className="sdiff-stat-num" style={{ color: s.color }}>{s.count}</div>
            <div className="sdiff-stat-label">{s.label}</div>
            <div className="sdiff-stat-hint">{s.hint}</div>
          </div>
        ))}
      </div>

      {/* ── In sync banner ── */}
      {isDiffFree && (
        <div className="sdiff-sync-banner">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Schemas are in sync — no drift detected.
        </div>
      )}

      {/* ── AI analysis card ── */}
      {aiAnalysis && (
        <div className="sdiff-ai-analysis-card">
          <div className="sdiff-ai-analysis-hd">
            <div className="sdiff-ai-analysis-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
              </svg>
            </div>
            <span className="sdiff-ai-analysis-label">AI Analysis</span>
            <span
              className="sdiff-risk-badge"
              style={{ color: RISK_COLOR[aiAnalysis.riskLevel] ?? '#4ade80', background: RISK_BG[aiAnalysis.riskLevel] ?? 'rgba(74,222,128,.12)', borderColor: (RISK_COLOR[aiAnalysis.riskLevel] ?? '#4ade80') + '40' }}
            >
              {(aiAnalysis.riskLevel ?? 'none').toUpperCase()} RISK
            </span>
          </div>
          {aiAnalysis.headline && <div className="sdiff-ai-headline">{aiAnalysis.headline}</div>}
          {aiAnalysis.summary  && (
            <div className="sdiff-ai-summary">
              <MarkdownView content={aiAnalysis.summary} />
            </div>
          )}
          {aiAnalysis.migrationAdvice && (
            <div className="sdiff-ai-advice">
              <div className="sdiff-ai-advice-label">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                Migration steps
              </div>
              <div className="sdiff-ai-advice-body">
                <MarkdownView content={aiAnalysis.migrationAdvice} />
              </div>
            </div>
          )}
          {aiAnalysis.inSyncNote && (
            <div className="sdiff-ai-sync-note">
              <MarkdownView content={aiAnalysis.inSyncNote} />
            </div>
          )}
        </div>
      )}

      {/* ── Drift sections ── */}
      {[
        { key: 'src',  items: onlyInSrc, title: 'Missing from Target', color: '#ef4444', sigil: '−' },
        { key: 'tgt',  items: onlyInTgt, title: 'Extra in Target',     color: '#f97316', sigil: '+' },
        { key: 'ddl',  items: drifted,   title: 'DDL Drift',           color: '#eab308', sigil: '~' },
      ].filter(s => s.items.length > 0).map(s => {
        const collapsed = !!sectionCollapsed[s.key];
        return (
          <div key={s.key} className="sdiff-section">
            <button type="button" className="sdiff-section-hd" onClick={() => toggleSection(s.key)}>
              <span className={`sdiff-section-chevron${collapsed ? '' : ' open'}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </span>
              <span className="sdiff-section-title" style={{ color: s.color, background: s.color + '18' }}>{s.title}</span>
              <span className="sdiff-section-badge" style={{ color: s.color, background: s.color + '20' }}>{s.items.length}</span>
            </button>
            {!collapsed && (
              <div className="sdiff-section-body">
                {s.key === 'ddl'
                  ? renderGrouped(s.key, s.items, (o, i) => {
                      const key = `${o.schema ?? ''}.${o.name}`;
                      const exp = expandedDdl.has(key);
                      return (
                        <div key={i} className="sdiff-ddl-item">
                          <button type="button" className={`sdiff-ddl-toggle${exp ? ' open' : ''}`} onClick={() => toggleDdl(key)}>
                            <span className="sdiff-ddl-item-name" title={`${o.schema ? o.schema + '.' : ''}${o.name}`}>
                              {o.schema ? <span className="sdiff-ddl-schema">{o.schema}.</span> : null}{o.name}
                            </span>
                            <svg className={`sdiff-ddl-chev${exp ? ' open' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="9 18 15 12 9 6"/>
                            </svg>
                          </button>
                          {exp && (o.left_ddl || o.right_ddl) && (
                            <div className="sdiff-ddl-diff-editor">
                              <DiffEditorView
                                key={key}
                                original={o.left_ddl ?? '-- (none)'}
                                modified={o.right_ddl ?? '-- (none)'}
                                language="sql"
                                height={300}
                                readOnly={true}
                                renderSideBySide={true}
                                theme="vs-dark"
                                                              />
                            </div>
                          )}
                        </div>
                      );
                    })
                  : renderGrouped(s.key, s.items, (o, i) => {
                      const tc = OBJ_COLORS[(o.type ?? 'object') as ObjType] ?? '#64748b';
                      const badge = TYPE_BADGE[(o.type ?? 'object')] ?? (o.type?.toUpperCase().slice(0, 4) ?? 'OBJ');
                      return (
                        <div key={i} className="sdiff-card" style={{ borderTopColor: s.color }}>
                          <span className="sdiff-card-type-badge" style={{ background: tc + '1e', color: tc, border: `1px solid ${tc}44` }}>{badge}</span>
                          <div className="sdiff-card-name" title={`${o.schema ? o.schema + '.' : ''}${o.name}`}>{o.name}</div>
                          {o.schema && <div className="sdiff-card-schema">{o.schema}</div>}
                        </div>
                      );
                    }, true)
                }
              </div>
            )}
          </div>
        );
      })}

      {/* ── Node Graph view (D11.5) ── */}
      {graphView && (
        <div style={{ marginBottom: 16 }}>
          <SchemaNodeGraph data={data} />
        </div>
      )}

      {/* ── Export + Generate Migration + Raw JSON ── */}
      <div className="sdiff-raw-row">
        <button type="button" className={`sdiff-raw-btn${graphView ? ' active' : ''}`} onClick={() => setGraphView(v => !v)} title="Toggle interactive node graph view">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="12" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="19" cy="19" r="3"/><line x1="8" y1="12" x2="16" y2="5"/><line x1="8" y1="12" x2="16" y2="19"/></svg>
          {graphView ? 'Hide graph' : 'Node Graph'}
        </button>
        <button type="button" className="sdiff-raw-btn" onClick={handleExportReport} title="Download report as Markdown">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export Markdown
        </button>
        {(drifted.length > 0 || onlyInSrc.length > 0) && (
          <button type="button" className="sdiff-raw-btn" onClick={handleGenerateMigration} title="Open Freeform with migration SQL pre-filled">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Generate Migration
          </button>
        )}
        <button type="button" className="sdiff-raw-btn" onClick={() => setRawVisible(v => !v)}>
          {rawVisible
            ? <><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg> Hide raw JSON</>
            : <><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg> Show raw JSON</>
          }
        </button>
        {rawVisible && (
          <div className="sdiff-raw-editor">
            <EditorView
              language="json"
              value={JSON.stringify(data, null, 2)}
              height={400}
              readOnly={true}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── DDL Diff View (Monaco DiffEditor) ─────────────────────────────── */
/* ─── D18.10 Drift Detective Result ─────────────────────────────── */
function DriftDetectiveResult({ result }: { result: Record<string, unknown> }) {
  const analysis = (result.analysis as Record<string, string> | undefined) ?? {};
  const onlyInSrc = (result.onlyInSrc as string[] | undefined) ?? [];
  const onlyInTgt = (result.onlyInTgt as string[] | undefined) ?? [];
  const commonCount = (result.common as number | undefined) ?? 0;
  const schema = (result.schema as string | undefined) ?? '';
  const riskColor = analysis.riskLevel === 'high' ? '#f87171' : analysis.riskLevel === 'medium' ? '#fbbf24' : '#4ade80';

  return (
    <div style={{ margin: '8px 0', padding: '10px 14px', background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.25)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#f97316' }}>Drift Detective — {schema}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 7px', borderRadius: 10, background: riskColor + '22', color: riskColor, fontWeight: 700, border: `1px solid ${riskColor}44` }}>
          {(analysis.riskLevel ?? 'unknown').toUpperCase()}
        </span>
      </div>
      {analysis.headline && <p style={{ margin: '0 0 8px', fontSize: 11.5, color: '#cbd5e1', fontWeight: 600 }}>{analysis.headline}</p>}
      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#94a3b8', marginBottom: onlyInSrc.length + onlyInTgt.length > 0 ? 8 : 0 }}>
        <span><span style={{ color: '#f87171', fontWeight: 700 }}>{onlyInSrc.length}</span> missing from target</span>
        <span><span style={{ color: '#fb923c', fontWeight: 700 }}>{onlyInTgt.length}</span> extra in target</span>
        <span><span style={{ color: '#4ade80', fontWeight: 700 }}>{commonCount}</span> shared tables</span>
      </div>
      {(onlyInSrc.length > 0 || onlyInTgt.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {onlyInSrc.map(t => <span key={t} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.25)' }}>− {t}</span>)}
          {onlyInTgt.map(t => <span key={t} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(251,146,60,0.12)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.25)' }}>+ {t}</span>)}
        </div>
      )}
      {analysis.migrationAdvice && (
        <div style={{ fontSize: 11, color: '#94a3b8', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6, marginTop: 4 }}>
          <span style={{ color: '#f97316', fontWeight: 600 }}>Advice: </span>{analysis.migrationAdvice}
        </div>
      )}
    </div>
  );
}

function MonacoDiffView({ pairs, onClose }: { pairs: DdlPair[]; onClose: () => void }) {
  const [activePair, setActivePair] = useState(pairs[0]?.id ?? '');
  const current = pairs.find(p => p.id === activePair) ?? pairs[0];

  const srcContent = current
    ? (current.sourceDdl || `-- Object not present in source\n-- ${current.schema ? current.schema + '.' : ''}${current.name}`)
    : '';
  const tgtContent = current
    ? (current.targetDdl || `-- Object not present in target\n-- ${current.schema ? current.schema + '.' : ''}${current.name}`)
    : '';

  return (
    <div className="sdiff-diff-modal-frame">
      {/* ── Modal header ── */}
      <div className="sdiff-diff-modal-hd">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/>
        </svg>
        <span className="sdiff-diff-view-title">DDL Diff View</span>
        <span className="sdiff-diff-modal-count">{pairs.length} object{pairs.length !== 1 ? 's' : ''}</span>
        <button className="sdiff-diff-close" onClick={onClose} title="Close">×</button>
      </div>

      {/* ── Body: sidebar + diff editor ── */}
      <div className="sdiff-diff-modal-body">
        {/* Left sidebar — file list */}
        <div className="sdiff-diff-sidebar">
          <div className="sdiff-diff-sidebar-hd">Objects</div>
          {pairs.map(p => (
            <button
              key={p.id}
              className={`sdiff-diff-file-item${p.id === activePair ? ' active' : ''}`}
              onClick={() => setActivePair(p.id)}
              title={`${p.schema ? p.schema + '.' : ''}${p.name}`}
            >
              <span className="sdiff-diff-file-icon" style={{ color: OBJ_COLORS[p.type as ObjType] ?? '#94a3b8' }}>
                {OBJ_ICONS[p.type as ObjType] ?? '•'}
              </span>
              <span className="sdiff-diff-file-name">{p.name}</span>
            </button>
          ))}
        </div>

        {/* Right: Monaco DiffEditor */}
        {current && (
          <div className="sdiff-diff-editor-panel">
            <div className="sdiff-diff-editor-container">
              <DiffEditorView
                key={current.id}
                original={srcContent}
                modified={tgtContent}
                language="sql"
                height="100%"
                readOnly={true}
                renderSideBySide={true}
                theme="vs-dark"
                              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


