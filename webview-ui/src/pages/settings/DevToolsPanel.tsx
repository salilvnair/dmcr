import React, { useState } from 'react';
import { postMsg } from '../../vscode';
import type { CeAuditEntry, SystemInfoPayload, DbInfoPayload } from '../../types';
import { ChipIcon } from './icons';
import { ButtonView, RefreshIcon, ChevronRightIcon, BrainIcon, AgentIcon, ClipboardCheckIcon, ScopeIcon, DatabaseTableIcon, BugIcon } from '@salilvnair/dui';
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

const DEV_TOOLS: { id: NonNullable<DevTool>; label: string; description: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'memory',      label: 'Memory Footprint', description: 'Extension process, OS memory, CPU and runtime info',             icon: BrainIcon },
  { id: 'aiFootprint', label: 'AI Footprint',     description: 'Full audit trail of all AI/LLM calls with payloads and timing', icon: AgentIcon },
  { id: 'auditLog',    label: 'Audit Log',        description: 'Complete trace: AI calls, MCP tool invocations, metadata, timing', icon: ClipboardCheckIcon },
  { id: 'agentTrace',  label: 'Agent Trace',      description: 'Live step-by-step agent pipeline trace for conversation sessions — model, timing, prompts, errors', icon: ScopeIcon },
  { id: 'dbExplorer',  label: 'DB Explorer',      description: 'Browse and manage SQLite tables — view, select, and delete rows', icon: DatabaseTableIcon },
  { id: 'debug',       label: 'Debug Snapshot',   description: 'Copy raw diagnostic JSON — DB status, audit entries, versions', icon: BugIcon },
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
          <ButtonView variant="ghost" iconLeft={<RefreshIcon size={13} />} label={refreshing ? 'Refreshing…' : 'Refresh'} loading={refreshing} style={{ marginLeft: 'auto' }} onClick={handleRefresh} />
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
              if (tool.id === 'agentTrace') postMsg({ type: 'getAuditTimeline', payload: { requestId: 'agentTrace' } });
              if (tool.id === 'memory') postMsg({ type: 'getSystemInfo' });
              if (tool.id === 'dbExplorer') postMsg({ type: 'getDbExplorerTables' });
              if (tool.id === 'debug') { postMsg({ type: 'getAiFootprint' }); postMsg({ type: 'getSystemInfo' }); postMsg({ type: 'getDbInfo' }); }
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 1 }}><tool.icon size={18} /></span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{tool.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)' }}>{tool.description}</span>
            </div>
            <span style={{ marginLeft: 'auto', opacity: 0.5, display: 'inline-flex', alignItems: 'center' }}><ChevronRightIcon size={13} /></span>
          </button>
        ))}
      </div>
    </div>
  );
}
