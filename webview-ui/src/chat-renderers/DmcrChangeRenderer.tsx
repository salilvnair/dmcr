import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import { oneLight, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import './DmcrChangeRenderer.css';
import { useAiFeatures } from '../utils/aiFeatures';
import { BlockedIcon, CheckCircleIcon, DiffIcon, FolderIcon, RenameIcon, SaveIcon, SettingsIcon, WarningTriangleIcon, XCircleIcon } from '@salilvnair/dui';

SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('json', json);

/* ── Minimal line diff (no external lib) ─────────────────────────── */
type DiffLine = { type: 'same' | 'add' | 'remove'; text: string };

function computeLineDiff(original: string, edited: string): DiffLine[] {
  const a = original.split('\n');
  const b = edited.split('\n');
  // Build LCS table
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'same', text: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', text: b[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'remove', text: a[i - 1] });
      i--;
    }
  }
  return result;
}

interface DmcrChangePayload {
  type: 'DmcrChange';
  changeName: string;
  deploySql: string;
  verifySql: string;
  revertSql: string;
  metaJson?: string;
  agent?: string;
}

interface LintState {
  status: 'pending' | 'ok' | 'error';
  msg: string;
}

type SqlTab = 'deploy' | 'verify' | 'revert' | 'meta';

// ─── Renderer Component ───────────────────────────────────────────────────────

export function DmcrChangeCard({ payload, actions }: { payload: DmcrChangePayload; actions: any }) {
  const [activeTab, setActiveTab] = useState<SqlTab>('deploy');
  const [lintMap, setLintMap] = useState<Record<SqlTab, LintState>>({
    deploy: { status: 'pending', msg: 'Linting…' },
    verify: { status: 'pending', msg: 'Linting…' },
    revert: { status: 'pending', msg: 'Linting…' },
    meta:   { status: 'ok',      msg: 'meta.json' },
  });

  const isDanger = payload.changeName?.includes('danger_') ?? false;
  const isRepeatable = payload.changeName?.startsWith('R__') ?? false;

  // D18.9 — Semantic versioning badge (instant, no LLM needed)
  const semverBadge = (() => {
    const sql = (payload.deploySql ?? '').toUpperCase();
    if (/DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)|ALTER\s+TABLE\s+\S+\s+(DROP|RENAME\s+COLUMN)/.test(sql))
      return { label: 'MAJOR', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' };
    if (/CREATE\s+TABLE|ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN|CREATE\s+(OR\s+REPLACE\s+)?VIEW|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/.test(sql))
      return { label: 'MINOR', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' };
    if (/CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE\s+\S+\s+ADD\s+CONSTRAINT|INSERT\s+INTO|UPDATE\s+|SET\s+DEFAULT/.test(sql))
      return { label: 'PATCH', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' };
    return null;
  })();

  const defaultMeta = payload.metaJson || JSON.stringify({
    change_id: payload.changeName,
    description: '',
    requires: [],
    tags: [],
    author: ''
  }, null, 2);

  // Editable content for all 4 tabs
  const [editDeploy, setEditDeploy] = useState(payload.deploySql);
  const [editVerify, setEditVerify] = useState(payload.verifySql);
  const [editRevert, setEditRevert] = useState(payload.revertSql);
  const [editMeta, setEditMeta] = useState(defaultMeta);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedPath, setSavedPath] = useState('');
  const [saveErrorMsg, setSaveErrorMsg] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [isLightTheme, setIsLightTheme] = useState(() => document.documentElement.dataset.theme === 'light');
  const [editing, setEditing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitDone, setCommitDone] = useState(false);
  const [commitError, setCommitError] = useState('');
  // D18.5 — AI Dependency Analyzer
  const [analyzingDeps, setAnalyzingDeps] = useState(false);
  const [suggestedRequires, setSuggestedRequires] = useState<string[] | null>(null);
  // D18.8 — AI SQL Policy Guard
  const [policyViolations, setPolicyViolations] = useState<Array<{ policy: string; violation: string; severity: string }> | null>(null);
  const [policyChecking, setPolicyChecking] = useState(false);
  // Settings → AI Features switches (the ref lets the delayed auto-check see the latest answer)
  const isAiOn = useAiFeatures();
  const isAiOnRef = useRef(isAiOn);
  isAiOnRef.current = isAiOn;

  // Editor refs for scroll sync
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);

  const lint = lintMap[activeTab];

  useEffect(() => {
    const changeId = payload.changeName;

    function handler(evt: MessageEvent) {
      const msg = evt.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'lintResult' && typeof msg.payload?.id === 'string' && msg.payload.id.includes('::')) {
        const tabKey = msg.payload.id.split('::')[1] as SqlTab | undefined;
        if (tabKey && ['deploy','verify','revert'].includes(tabKey)) {
          setLintMap(prev => ({
            ...prev,
            [tabKey]: msg.payload.ok
              ? { status: 'ok',    msg: `${tabKey}.sql` }
              : { status: 'error', msg: `${tabKey}.sql: ${msg.payload.msg}` },
          }));
        }
      }

      if (msg.type === 'saved' && msg.payload?.changeName === changeId) {
        setSaving(false);
        setSaved(true);
        setSavedPath(msg.payload?.folderRel || '');
      }

      // Match by changeName OR as a fallback when changeName is empty (older backend)
      if (msg.type === 'saveError' && (msg.payload?.changeName === changeId || !msg.payload?.changeName)) {
        setSaving(false);
        const errMsg: string = msg.payload?.msg || 'Save failed.';
        setSaveErrorMsg(errMsg);
      }

      if (msg.type === 'commitResult' && msg.payload?.requestId === `dmcrchange-${changeId}`) {
        setCommitting(false);
        if (msg.payload?.ok) {
          setCommitDone(true);
          setCommitError('');
        } else {
          setCommitError(msg.payload?.error || 'Commit failed.');
        }
      }

      if (msg.type === 'dependencyResult' && msg.payload?.changeName === changeId) {
        setAnalyzingDeps(false);
        setSuggestedRequires(msg.payload?.requires ?? []);
      }

      if (msg.type === 'policyValidationResult' && msg.payload?.changeName === changeId) {
        setPolicyChecking(false);
        setPolicyViolations(msg.payload?.violations ?? []);
      }
    }

    window.addEventListener('message', handler);

    const vscodeApi = (window as any).__DMCR_VSCODE_API__;
    if (vscodeApi) {
      // Lint all three SQL files with tab-keyed IDs
      const tabs: { key: SqlTab; sql: string }[] = [
        { key: 'deploy', sql: payload.deploySql },
        { key: 'verify', sql: payload.verifySql },
        { key: 'revert', sql: payload.revertSql },
      ];
      tabs.forEach(({ key, sql }, i) => {
        setTimeout(() => {
          vscodeApi.postMessage({ type: 'lintSql', payload: { id: `${changeId}::${key}`, sql } });
        }, 200 + i * 120);
      });
      // D18.8 — auto-run policy validation after a short delay
      setTimeout(() => {
        if (!isAiOnRef.current('AI_SQL_POLICY_GUARD')) return;
        setPolicyChecking(true);
        vscodeApi.postMessage({ type: 'validateSqlPolicy', payload: { changeName: changeId, deploySql: payload.deploySql } });
      }, 800);
    }

    return () => window.removeEventListener('message', handler);
  }, [payload.changeName, payload.deploySql, actions]);

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setIsLightTheme(root.dataset.theme === 'light');
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const handleSave = useCallback(() => {
    if (saving || saved) return;
    setSaving(true);
    setSaveErrorMsg('');
    const vscodeApi = (window as any).__DMCR_VSCODE_API__;
    if (vscodeApi) {
      vscodeApi.postMessage({
        type: 'saveChange',
        payload: {
          changeName: payload.changeName,
          deploySql:  editDeploy,
          verifySql:  editVerify,
          revertSql:  editRevert,
          metaJson:   editMeta,
        },
      });
    }
  }, [saving, saved, payload.changeName, editDeploy, editVerify, editRevert, editMeta]);

  const handleCancel = useCallback(() => {
    setDismissed(true);
  }, []);

  const handleCommit = useCallback(() => {
    if (!savedPath || committing || commitDone) return;
    setCommitting(true);
    setCommitError('');
    const vscodeApi = (window as any).__DMCR_VSCODE_API__;
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'manualCommitAndPush', payload: { folderRel: savedPath, requestId: `dmcrchange-${payload.changeName}` } });
    }
  }, [savedPath, committing, commitDone]);

  const syncScroll = useCallback(() => {
    if (taRef.current && hlRef.current) {
      hlRef.current.scrollTop = taRef.current.scrollTop;
      hlRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }, []);

  const SQL_TABS: { key: SqlTab; label: string }[] = [
    { key: 'deploy', label: 'deploy.sql' },
    { key: 'verify', label: 'verify.sql' },
    { key: 'revert', label: 'revert.sql' },
    { key: 'meta',   label: 'meta.json' },
  ];

  const sqlContent: Record<SqlTab, string> = {
    deploy: editDeploy,
    verify: editVerify,
    revert: editRevert,
    meta:   editMeta,
  };

  const originalContent: Record<SqlTab, string> = {
    deploy: payload.deploySql,
    verify: payload.verifySql,
    revert: payload.revertSql,
    meta:   defaultMeta,
  };

  const diffLines = useMemo(
    () => computeLineDiff(originalContent[activeTab], sqlContent[activeTab]),
    [activeTab, sqlContent[activeTab], originalContent[activeTab]],
  );

  const hasChanges = useMemo(
    () => diffLines.some(l => l.type !== 'same'),
    [diffLines],
  );

  if (dismissed) return (
    <div className="change-card-wrap change-card-wrap--dismissed">
      <div className="change-card change-card--dismissed">
        <div className="dmcr-dismissed">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><BlockedIcon size={14} />Discarded</span>
          <strong>{payload.changeName}</strong>
          <button className="dmcr-dismissed__undo" onClick={() => setDismissed(false)}>Undo</button>
        </div>
      </div>
    </div>
  );

  const setContent = (tab: SqlTab, val: string) => {
    if (tab === 'deploy') setEditDeploy(val);
    else if (tab === 'verify') setEditVerify(val);
    else if (tab === 'revert') setEditRevert(val);
    else setEditMeta(val);
  };

  return (
    <div className="change-card-wrap">
      <div className="change-card">
        {/* Header: change name + chips */}
        <div className="change-card-hd">
          <span className="change-name" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><FolderIcon size={13} />{payload.changeName}</span>
          {isDanger && <span className="dc-chip dc-chip-danger">danger_</span>}
          {isRepeatable && <span className="dc-chip dc-chip-repeatable">R__ repeatable</span>}
          {semverBadge && isAiOn('AI_SEMANTIC_VERSION') && (
            <span title="AI Semantic Version — impact classification" style={{
              fontSize: 9.5, fontWeight: 800, letterSpacing: 0.8, padding: '2px 7px', borderRadius: 5,
              background: semverBadge.bg, color: semverBadge.color,
              border: `1px solid ${semverBadge.color}44`,
            }}>{semverBadge.label}</span>
          )}
          {editing && <span className="dc-chip dc-chip-edited" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><RenameIcon size={11} />edited</span>}
          {editing && hasChanges && (
            <button
              type="button"
              className={`dc-diff-btn${showDiff ? ' active' : ''}`}
              onClick={() => setShowDiff(v => !v)}
              title="Toggle diff view"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{showDiff ? <><RenameIcon size={11} />Edit</> : <><DiffIcon size={11} />Diff</>}</span>
            </button>
          )}
          {/* D18.5 — AI Dependency Analyzer */}
          {isAiOn('AI_DEPENDENCY_ANALYZER') && <button
            type="button"
            style={{ marginLeft: 'auto', fontSize: 9.5, padding: '2px 7px', borderRadius: 5, border: '1px solid rgba(139,92,246,0.3)', background: 'rgba(139,92,246,0.08)', color: '#a78bfa', cursor: analyzingDeps ? 'default' : 'pointer', fontFamily: 'inherit', opacity: analyzingDeps ? 0.7 : 1 }}
            title="AI Dependency Analyzer — detect which existing changes this depends on"
            disabled={analyzingDeps}
            onClick={() => {
              setAnalyzingDeps(true);
              setSuggestedRequires(null);
              const vscodeApi = (window as any).__DMCR_VSCODE_API__;
              vscodeApi?.postMessage({ type: 'analyzeDependencies', payload: { changeName: payload.changeName, deploySql: editDeploy } });
            }}
          >{analyzingDeps ? '✦ Analyzing…' : '✦ Deps'}</button>}
          {suggestedRequires !== null && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              {suggestedRequires.length === 0 ? (
                <span style={{ fontSize: 9.5, color: '#4ade80', padding: '2px 6px', borderRadius: 4, background: 'rgba(74,222,128,0.1)' }}>✓ No dependencies found</span>
              ) : suggestedRequires.map(r => (
                <span key={r} style={{ fontSize: 9.5, color: '#a78bfa', padding: '2px 6px', borderRadius: 4, background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.25)', cursor: 'pointer' }}
                  title="Click to apply to meta.json requires field"
                  onClick={() => {
                    try {
                      const meta = JSON.parse(editMeta);
                      const existing = Array.isArray(meta.requires) ? meta.requires : [];
                      if (!existing.includes(r)) {
                        meta.requires = [...existing, r];
                        setEditMeta(JSON.stringify(meta, null, 2));
                      }
                    } catch { /* meta not valid JSON — ignore */ }
                  }}
                >{r} ↑</span>
              ))}
            </span>
          )}
        </div>

        {/* D18.8 — Policy violation banner */}
        {policyChecking && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', background: 'rgba(99,102,241,0.04)', borderBottom: '1px solid rgba(99,102,241,0.1)', fontSize: 10.5, color: '#64748b', fontStyle: 'italic', flexShrink: 0 }}>
            <span className="lint-spinner" />
            Checking SQL policies…
          </div>
        )}
        {policyViolations && policyViolations.length > 0 && (
          <div style={{ flexShrink: 0, borderBottom: '1px solid rgba(239,68,68,0.25)' }}>
            {policyViolations.map((v, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '5px 12px', background: v.severity === 'error' ? 'rgba(239,68,68,0.08)' : 'rgba(251,191,36,0.06)', borderBottom: i < policyViolations.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                <span style={{ fontSize: 10, color: v.severity === 'error' ? '#f87171' : '#fbbf24', flexShrink: 0, marginTop: 1, display: 'inline-flex' }}>{v.severity === 'error' ? '✗' : <WarningTriangleIcon size={11} />}</span>
                <div style={{ fontSize: 10.5, flex: 1 }}>
                  <span style={{ color: v.severity === 'error' ? '#f87171' : '#fbbf24', fontWeight: 600 }}>Policy: </span>
                  <span style={{ color: '#94a3b8' }}>{v.policy}</span>
                  <span style={{ color: '#64748b' }}> — {v.violation}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* SQL tabs */}
        <div className="sql-tabs">
          {SQL_TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`sql-tab${activeTab === key ? ' active' : ''}`}
              onClick={() => setActiveTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* SQL code block — editable with syntax highlighting / diff view */}
        {showDiff ? (
          <div className="dc-diff-view">
            {diffLines.map((line, i) => (
              <div key={i} className={`dc-diff-line dc-diff-line--${line.type}`}>
                <span className="dc-diff-gutter">{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
                <span className="dc-diff-text">{line.text || '\u00a0'}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className={`change-card-sql-scroll${editing ? ' change-card-sql-scroll--editing' : ''}`}>
            {/* Highlighted layer (behind) */}
            <div className="dc-editor-highlight" ref={hlRef} aria-hidden="true">
              <SyntaxHighlighter
                language={activeTab === 'meta' ? 'json' : 'sql'}
                style={isLightTheme ? oneLight : vscDarkPlus}
                wrapLongLines
                customStyle={{
                  margin: 0,
                  padding: '14px 16px',
                  background: 'transparent',
                  fontSize: '12px',
                  lineHeight: '1.65',
                  fontFamily: "ui-monospace,'Cascadia Code','JetBrains Mono',Consolas,monospace",
                  borderRadius: 0,
                  overflow: 'hidden',
                  minHeight: '100%',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
                codeTagProps={{ style: { fontFamily: 'inherit', background: 'transparent' } }}
              >
                {sqlContent[activeTab] || ' '}
              </SyntaxHighlighter>
            </div>

            {/* Editable textarea (on top, transparent text) */}
            <textarea
              ref={taRef}
              className="dc-editor-textarea"
              value={sqlContent[activeTab]}
              onChange={e => { setContent(activeTab, e.target.value); if (!editing) setEditing(true); }}
              onScroll={syncScroll}
              spellCheck={false}
            />
          </div>
        )}

        {/* Save error banner */}
        {saveErrorMsg && (
          <div className="change-card-save-error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>{saveErrorMsg}</span>
            <button type="button" className="change-card-save-error__dismiss" onClick={() => setSaveErrorMsg('')} title="Dismiss">×</button>
          </div>
        )}

        {/* Footer: lint left, buttons right */}
        <div className="change-card-footer">
          <div className={`lint-row lint-${lint.status === 'pending' ? 'idle' : lint.status === 'ok' ? 'ok' : 'err'}`}>
            {lint.status === 'pending' && <span className="lint-spinner" />}
            {lint.status === 'ok' && <CheckCircleIcon size={12} style={{ flexShrink: 0 }} />}
            {lint.status === 'error' && <XCircleIcon size={12} style={{ flexShrink: 0 }} />}
            {lint.msg}
          </div>
          <div className="change-card-actions">
            {!saved && (
              <button
                type="button"
                className="btn-clear"
                disabled={saving}
                onClick={handleCancel}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className={`change-save-btn${saved ? ' change-save-btn--saved' : ''}`}
              disabled={saving || saved}
              onClick={handleSave}
            >
              {saved ? <><CheckCircleIcon size={13} />Saved</> : saving ? 'Saving…' : <><SaveIcon size={13} />Save to workspace</>}
            </button>
          </div>
        </div>

        {/* Footer 2: saved path confirmation bar */}
        {saved && savedPath && (
          <div className="change-card-saved-bar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Saved to</span>
            <span className="change-card-saved-path">{savedPath}</span>
            <button
              type="button"
              className="change-card-reveal-btn"
              onClick={() => {
                const vscodeApi = (window as any).__DMCR_VSCODE_API__;
                if (vscodeApi) vscodeApi.postMessage({ type: 'revealFolder', payload: { folderRel: savedPath } });
              }}
            >
              Reveal in Explorer
            </button>
            <button
              type="button"
              className={`change-card-commit-btn${commitDone ? ' done' : ''}`}
              onClick={handleCommit}
              disabled={committing || commitDone}
              title={commitDone ? 'Committed & pushed' : 'Commit & push to configured git remote'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              {commitDone ? 'Committed ✓' : committing ? 'Committing…' : 'Commit'}
            </button>
          </div>
        )}
        {commitError && (
          <div className="change-card-save-error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>Commit failed: {commitError}</span>
            <button type="button" className="change-card-save-error__dismiss" onClick={() => setCommitError('')} title="Dismiss">×</button>
          </div>
        )}
      </div>
      {payload.agent && (
        <div className="dmcr-agent-badge" title={`Generated by DMCR Generator`} style={{ '--agent-color': '#34d399' } as React.CSSProperties}>
          <span className="dmcr-agent-badge__icon" style={{ display: 'inline-flex' }}><SettingsIcon size={11} /></span>
          <span className="dmcr-agent-badge__label">DMCR Generator</span>
        </div>
      )}
    </div>
  );
}

// ─── Renderer Provider ────────────────────────────────────────────────────────

export const dmcrChangeRendererProvider = {
  key: 'DmcrChange',
  priority: 300,
  hideBubble: false,
  match: ({ payload, effectiveType }: { payload: any; effectiveType: string }) => {
    if (effectiveType === 'DmcrChange') return true;
    if (!payload || typeof payload !== 'object') return false;
    return (
      typeof payload.changeName === 'string' &&
      typeof payload.deploySql  === 'string' &&
      typeof payload.verifySql  === 'string' &&
      typeof payload.revertSql  === 'string'
    );
  },
  Component: DmcrChangeCard,
};
