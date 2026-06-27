import React, { useState } from 'react';
import { postMsg } from '../../vscode';
import type { CeAuditEntry, SystemInfoPayload, DbInfoPayload } from '../../types';
import { ChipIcon } from './icons';
import { MemoryPanel } from './devtools/MemoryPanel';
import { AiFootprintPanel } from './devtools/AiFootprintPanel';
import { AuditLogPanel } from './devtools/AuditLogPanel';
import { DebugPanel } from './devtools/DebugPanel';
import { DbExplorerPanel } from './devtools/DbExplorerPanel';
import { AgentTracePanel } from './devtools/AgentTracePanel';
import { BackBtn } from './devtools/BackBtn';

/* ============================================================
 * Developer Tools Panel (router)
 * ============================================================ */
type DevTool = 'memory' | 'aiFootprint' | 'auditLog' | 'agentTrace' | 'debug' | 'dbExplorer' | null;

const DEV_TOOLS: { id: NonNullable<DevTool>; label: string; description: string; icon: string }[] = [
  { id: 'memory',      label: 'Memory Footprint', description: 'Extension process, OS memory, CPU and runtime info',             icon: '🧠' },
  { id: 'aiFootprint', label: 'AI Footprint',     description: 'Full audit trail of all AI/LLM calls with payloads and timing', icon: '🤖' },
  { id: 'auditLog',    label: 'Audit Log',        description: 'Complete trace: AI calls, MCP tool invocations, metadata, timing', icon: '📋' },
  { id: 'agentTrace',  label: 'Agent Trace',      description: 'Live step-by-step agent pipeline trace for conversation sessions — model, timing, prompts, errors', icon: '🕵️' },
  { id: 'dbExplorer',  label: 'DB Explorer',      description: 'Browse and manage SQLite tables — view, select, and delete rows', icon: '🗄️' },
  { id: 'debug',       label: 'Debug Snapshot',   description: 'Copy raw diagnostic JSON — DB status, audit entries, versions', icon: '🐛' },
];

export function DevToolsPanel({ systemInfo, aiFootprint, dbInfo, initialActive, onActiveChange }: { systemInfo?: SystemInfoPayload | null; aiFootprint?: { entries: CeAuditEntry[]; limit: number } | null; dbInfo?: DbInfoPayload | null; initialActive?: string; onActiveChange?: (tool: string | undefined) => void }) {
  const [active, setActive] = useState<DevTool>((initialActive as DevTool) ?? null);
  const [refreshing, setRefreshing] = useState(false);

  function changeActive(tool: DevTool) {
    setActive(tool);
    onActiveChange?.(tool ?? undefined);
  }

  function handleRefresh() {
    setRefreshing(true);
    postMsg({ type: 'getSystemInfo' });
    setTimeout(() => setRefreshing(false), 800);
  }

  if (active === 'memory') {
    return (
      <div className="bs-settings-pane">
        <div className="bs-settings-section-head">
          <BackBtn onClick={() => changeActive(null)} />
          <ChipIcon className="bs-ico-sm" />
          <h3 className="bs-settings-h3">Memory Footprint</h3>
          <button className="bs-btn-sm bs-btn-secondary" style={{ marginLeft: 'auto' }} onClick={handleRefresh}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.27" />
            </svg>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <MemoryPanel systemInfo={systemInfo} headless />
      </div>
    );
  }

  if (active === 'aiFootprint') {
    return <AiFootprintPanel entries={aiFootprint?.entries ?? []} onBack={() => changeActive(null)} />;
  }

  if (active === 'auditLog') {
    return <AuditLogPanel entries={aiFootprint?.entries ?? []} onBack={() => changeActive(null)} />;
  }

  if (active === 'agentTrace') {
    return <AgentTracePanel onBack={() => changeActive(null)} />;
  }

  if (active === 'dbExplorer') {
    return <DbExplorerPanel onBack={() => changeActive(null)} />;
  }

  if (active === 'debug') {
    return <DebugPanel systemInfo={systemInfo} aiFootprint={aiFootprint} dbInfo={dbInfo} onBack={() => changeActive(null)} />;
  }

  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <ChipIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3">Developer Tools</h3>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {DEV_TOOLS.map(tool => (
          <button
            key={tool.id}
            className="bs-settings-sidebar-item"
            style={{ justifyContent: 'flex-start', gap: 12, padding: '10px 14px', borderRadius: 8, width: '100%', textAlign: 'left' }}
            onClick={() => {
              changeActive(tool.id);
              if (tool.id === 'aiFootprint' || tool.id === 'auditLog') postMsg({ type: 'getAiFootprint' });
              if (tool.id === 'agentTrace') postMsg({ type: 'getAuditTimeline' });
              if (tool.id === 'memory') postMsg({ type: 'getSystemInfo' });
              if (tool.id === 'dbExplorer') postMsg({ type: 'getDbExplorerTables' });
              if (tool.id === 'debug') { postMsg({ type: 'getAiFootprint' }); postMsg({ type: 'getSystemInfo' }); postMsg({ type: 'getDbInfo' }); }
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1 }}>{tool.icon}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{tool.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)' }}>{tool.description}</span>
            </div>
            <svg style={{ marginLeft: 'auto', opacity: 0.5 }} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
