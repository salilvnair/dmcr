import { useState, useRef, useCallback } from 'react';
import type { GenState } from '../types';
import { postMsg } from '../vscode';
import { ButtonView } from '@salilvnair/dui';
import dmcrBotPng from '../../../images/dmcr_bot.png';

interface Props {
  genState: GenState;
  onOpenForm: (form: string) => void;
  onContextMenu?: (form: string, e: React.MouseEvent) => void;
  sqliteStatus: 'ok' | 'error';
  sqliteError?: string;
  hasDbMcp?: boolean;
  generatingForms?: Set<string>;
  recentForms?: string[];
  workspaceReady?: boolean;
  /** Clears every form draft (DDL, DML, Freeform, Diff, Assistant); asks for a second click first. */
  onClearAllForms?: () => void;
  confirmClearAll?: boolean;
}

/** Eraser: clears the saved form drafts. */
function ClearFormsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 21h10" />
      <path d="M5.5 13.5 13 6a2.1 2.1 0 0 1 3 0l3 3a2.1 2.1 0 0 1 0 3l-7.5 7.5H9z" />
      <path d="m9 10 5 5" />
    </svg>
  );
}

const FORMS = [
  {
    id: 'ddl',
    title: 'Schema Builder',
    desc: 'ALTER TABLE, CREATE TABLE, CREATE SEQUENCE with role grants',
    badge: 'DDL',
    badgeColor: '#60a5fa',
    icon: <DDLIcon />,
  },
  {
    id: 'insert',
    title: 'Insert Rows',
    desc: 'Seed data with idempotent ON CONFLICT handling',
    badge: 'DML',
    badgeColor: '#34d399',
    icon: <InsertIcon />,
  },
  {
    id: 'freeform',
    title: 'Freeform SQL',
    desc: 'Any SQL - AI generates deploy / verify / revert',
    badge: 'SQL',
    badgeColor: '#818cf8',
    icon: <FreeformIcon />,
  },
  {
    id: 'conversation',
    title: 'DMCR Assistant',
    desc: 'Chat with Copilot to build DMCR changes end-to-end',
    badge: 'AI',
    badgeColor: '#f472b6',
    icon: <ConversationIcon />,
  },
  {
    id: 'runner',
    title: 'Runner',
    desc: 'Deploy, verify, revert — live terminal inside VS Code',
    badge: 'CLI',
    badgeColor: '#6366f1',
    icon: <RunnerIcon />,
  },
  {
    id: 'schema_diff',
    title: 'Schema Diff',
    desc: 'Compare two schemas and generate change SQL',
    badge: 'DIFF',
    badgeColor: '#a78bfa',
    icon: <SchemaDiffIcon />,
  },
  {
    id: 'schema_explorer',
    title: 'Schema Explorer',
    desc: 'Browse database schemas, tables & columns via MCP',
    badge: 'DB',
    badgeColor: '#f59e0b',
    icon: <DbExplorerIcon />,
  },
] as const;

export default function HomePage({ genState, onOpenForm, onContextMenu, sqliteStatus, sqliteError, hasDbMcp, generatingForms, recentForms, workspaceReady, onClearAllForms, confirmClearAll }: Props) {
  const busy = genState.status === 'opening' || genState.status === 'running';

  return (
    <div className="bs-home-page" style={{ height: '100%', overflowY: 'auto', background: 'var(--bg-primary)' }}>

      {/* -- SQLite install banner -- */}
      {sqliteStatus === 'error' && <SqliteBanner error={sqliteError} />}

      {/* -- Workspace not configured banner -- */}
      {workspaceReady === false && (
        <div style={{
          margin: '12px 16px 0',
          padding: '10px 14px',
          borderRadius: 8,
          border: '1px solid rgba(251,191,36,.35)',
          background: 'rgba(251,191,36,.06)',
          fontSize: 12,
          color: '#fbbf24',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span style={{ color: 'var(--text-secondary, #94a3b8)' }}>
            No changes directory configured —{' '}
            <button
              style={{ background: 'none', border: 'none', padding: 0, color: '#fbbf24', cursor: 'pointer', textDecoration: 'underline', fontSize: 12 }}
              onClick={() => window.postMessage({ type: 'navigateToTab', payload: { tab: 'settings' } }, '*')}
            >
              go to Settings → DMCR Config
            </button>
          </span>
        </div>
      )}

      {/* -- Hero -- */}
      <HeroCard />

      {/* Generation status bar */}
      {genState.status !== 'idle' && <GenBar state={genState} />}

      {/* Clear saved form drafts (they are restored on every load) */}
      {onClearAllForms && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px 0' }}>
          <ButtonView
            label={confirmClearAll ? 'Click again to clear all forms' : 'Clear all forms'}
            variant={confirmClearAll ? 'danger' : 'ghost'}
            size="sm"
            iconLeft={<ClearFormsIcon />}
            title="Empty the DDL, DML, Freeform, Diff and Assistant forms. Saved change folders are not touched."
            onClick={onClearAllForms}
          />
        </div>
      )}

      {/* -- Form cards -- */}
      <div className="bs-home-grid">
        {FORMS.map(form => {
          const isGenerating = generatingForms?.has(form.id);
          const isRecent = recentForms?.slice(0, 2).includes(form.id);
          const isMcpExplorer = form.id === 'schema_explorer';
          return (
            <button
              key={form.id}
              className="bs-home-card"
              disabled={busy || (form as { disabled?: boolean }).disabled}
              onClick={() => !(form as { disabled?: boolean }).disabled && onOpenForm(form.id)}
              onContextMenu={onContextMenu ? (e) => onContextMenu(form.id, e) : undefined}
              style={{ position: 'relative' }}
            >
              {/* Busy pulsing ring */}
              {isGenerating && (
                <span style={{
                  position: 'absolute', inset: -1, borderRadius: 10,
                  border: '2px solid #818cf8',
                  animation: 'bs-pulse-ring 1.2s ease-in-out infinite',
                  pointerEvents: 'none',
                }} />
              )}
              <span className="bs-home-card-icon" style={{ position: 'relative' }}>
                {form.icon}
                {/* MCP status dot on Schema Explorer */}
                {isMcpExplorer && (
                  <span style={{
                    position: 'absolute', top: -2, right: -2,
                    width: 8, height: 8, borderRadius: '50%',
                    background: hasDbMcp ? '#22c55e' : '#ef4444',
                    border: '1.5px solid var(--bg-primary, #0f172a)',
                  }} title={hasDbMcp ? 'DB MCP connected' : 'No DB MCP connected'} />
                )}
              </span>
              <span className="bs-home-card-badge" style={{
                background: `${form.badgeColor}18`,
                color: form.badgeColor,
                border: `1px solid ${form.badgeColor}40`,
              }}>
                {form.badge}
              </span>
              <span className="bs-home-card-title">
                {form.title}
                {isRecent && (
                  <span style={{
                    marginLeft: 6, fontSize: 9, fontWeight: 600, letterSpacing: 0.4,
                    color: '#818cf8', background: 'rgba(99,102,241,0.12)',
                    border: '1px solid rgba(99,102,241,0.3)',
                    padding: '1px 5px', borderRadius: 4, verticalAlign: 'middle',
                  }}>recent</span>
                )}
              </span>
              <span className="bs-home-card-desc">{form.desc}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* --- SQLite install / rebuild banner ---------------------------------------- */

function SqliteBanner({ error }: { error?: string }) {
  const [building, setBuilding] = useState(false);

  const handleFix = () => {
    setBuilding(true);
    postMsg({ type: 'rebuildSqlite' });
  };

  return (
    <div style={{
      margin: '16px 16px 0',
      borderRadius: 12,
      border: '1px solid rgba(251,191,36,.35)',
      background: 'linear-gradient(135deg, rgba(251,191,36,.08) 0%, rgba(245,158,11,.04) 100%)',
      overflow: 'hidden',
    }}>
      {/* Top accent bar */}
      <div style={{ height: 3, background: 'linear-gradient(90deg, #f59e0b, #fbbf24, #6366f1)' }} />

      <div style={{ padding: '16px 20px 18px', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Icon */}
        <div style={{
          flexShrink: 0, width: 42, height: 42, borderRadius: 10,
          background: 'rgba(251,191,36,.12)', border: '1px solid rgba(251,191,36,.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <DatabaseSetupIcon />
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24' }}>
              SQLite not ready
            </span>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 20,
              background: 'rgba(251,191,36,.15)', color: '#fbbf24',
              border: '1px solid rgba(251,191,36,.3)', letterSpacing: '0.04em',
            }}>
              ABI MISMATCH
            </span>
          </div>

          <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            The bundled SQLite native binary was compiled for a different Electron version.
            Click <strong style={{ color: '#e5e7eb' }}>Install SQLite</strong> to rebuild it
            for your VS Code — takes about 30s.
          </p>

          {error && (
            <div style={{
              marginBottom: 10, padding: '6px 10px', borderRadius: 6,
              background: 'rgba(0,0,0,.25)', border: '1px solid rgba(255,255,255,.06)',
              fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
              color: '#94a3b8', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {error.slice(0, 200)}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={handleFix}
              disabled={building}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '7px 16px', borderRadius: 8, border: 'none', cursor: building ? 'default' : 'pointer',
                fontWeight: 600, fontSize: 12,
                background: building
                  ? 'rgba(99,102,241,.15)'
                  : 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                color: building ? '#818cf8' : '#fff',
                boxShadow: building ? 'none' : '0 2px 8px rgba(99,102,241,.35)',
                transition: 'all .15s',
              }}
            >
              {building ? (
                <>
                  <SpinIcon />
                  Building for VS Code...
                </>
              ) : (
                <>
                  <WrenchIcon />
                  Install SQLite
                </>
              )}
            </button>

            {!building && (
              <span style={{ fontSize: 11, color: '#64748b' }}>
                Rebuilds native binary for your Electron version
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* --- Generation status bar ------------------------------------------ */
function GenBar({ state }: { state: GenState }) {
  if (state.status === 'idle') return null;

  if (state.status === 'opening' || state.status === 'running') {
    return (
      <div className="bs-gen-bar">
        <span className="bs-spin" style={{ width: 12, height: 12, borderRadius: '50%', border: '1.5px solid transparent', borderTopColor: '#818cf8', display: 'inline-block' }} />
        {state.status === 'opening' ? 'Opening form...' : `Generating ${state.form}...`}
      </div>
    );
  }

  if (state.status === 'done') {
    return (
      <div className="bs-gen-bar is-done">
        &#10003; Created{' '}
        <button className="bs-gen-bar-link" onClick={() => postMsg({ type: 'revealFolder', payload: { folderRel: state.folderRel } })}>
          {state.folderId}
        </button>
        {state.isDanger && (
          <span style={{ marginLeft: 8, color: '#fbbf24', fontSize: 11 }}>&#9888; danger - manual deploy required</span>
        )}
        <button
          className="bs-gen-bar-link"
          style={{ marginLeft: 12 }}
          onClick={() => postMsg({ type: 'gitSync' })}
          title="Git pull, commit all changes, and push"
        >
          &#128260; Sync
        </button>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="bs-gen-bar is-error">
        &#10007; {state.message}
      </div>
    );
  }

  return null;
}

/* --- Hero Card with glare effect ----------------------------------------- */
function HeroCard() {
  const cardRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);

  const handleMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const glare = glareRef.current;
    if (!glare) return;
    const rect = (cardRef.current ?? glare).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    glare.style.opacity = '1';
    glare.style.background = `radial-gradient(circle at ${x}px ${y}px, rgba(99,102,241,0.22) 0%, rgba(99,102,241,0.06) 40%, transparent 70%)`;
  }, []);

  const handleLeave = useCallback(() => {
    const glare = glareRef.current;
    if (glare) glare.style.opacity = '0';
  }, []);

  return (
    <div
      ref={cardRef}
      className="bs-home-hero"
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
    >
      {/* Glare overlay */}
      <div ref={glareRef} className="bs-home-hero-glare" />

      {/* Corner glow */}
      <div className="bs-home-hero-glow" />

      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <img src={dmcrBotPng} alt="DMCR" style={{ width: 46, height: 46, objectFit: 'contain', filter: 'drop-shadow(0 8px 18px rgba(0,0,0,0.26))' }} />
        <div>
          <span className="bs-home-hero-eyebrow">DMCR</span>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: '0.02em' }}>
            Transactional PostgreSQL Change Ops
          </h1>
        </div>
      </div>

      <p style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.6, maxWidth: '46ch' }} className="bs-home-hero-desc">
        DMCR combines AI-assisted change generation, versioned change folders, transactional deploy and revert, and a runner with safety gates for destructive SQL.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {['deploy.sql', 'verify.sql', 'revert.sql', 'danger_ gate', 'Runner tab'].map(label => (
          <span key={label} className="bs-home-hero-chip">{label}</span>
        ))}
      </div>
    </div>
  );
}

/* --- SVG Icons ------------------------------------------------------ */
function DatabaseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.6">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4.03 3-9 3S3 13.66 3 12" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function DatabaseSetupIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.6">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 11v3c0 1.66 4.03 3 9 3" strokeDasharray="2 2" />
      <circle cx="18" cy="18" r="3" stroke="#6366f1" />
      <path d="M18 16.5v1.5l1 1" strokeLinecap="round" stroke="#6366f1" />
    </svg>
  );
}

function DDLIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.6">
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" strokeLinejoin="round" />
      <path d="M14 17h6M17 14v6" strokeLinecap="round" />
    </svg>
  );
}

function InsertIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="1.6">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" strokeLinecap="round" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <line x1="12" y1="11" x2="12" y2="17" strokeLinecap="round" />
      <line x1="9" y1="14" x2="15" y2="14" strokeLinecap="round" />
    </svg>
  );
}

function FreeformIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.6">
      <polyline points="16 18 22 12 16 6" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="8 6 2 12 8 18" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ConversationIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f472b6" strokeWidth="1.6">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RunnerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function ComingSoonIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SchemaDiffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="9" height="18" rx="1.5"/>
      <rect x="13" y="3" width="9" height="18" rx="1.5"/>
      <line x1="11" y1="7" x2="13" y2="7"/>
      <line x1="11" y1="12" x2="13" y2="12"/>
      <line x1="11" y1="17" x2="13" y2="17"/>
    </svg>
  );
}

function DbExplorerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function SpinIcon() {
  return (
    <span style={{
      display: 'inline-block', width: 11, height: 11, borderRadius: '50%',
      border: '1.5px solid rgba(129,140,248,.4)', borderTopColor: '#818cf8',
      animation: 'spin .7s linear infinite',
    }} />
  );
}