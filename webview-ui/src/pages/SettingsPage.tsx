import React, { useState, useEffect } from 'react';
import type { AppTheme, SettingsSnapshot, CeAuditEntry } from '../types';
import type { ToastData } from '../App';
import type { DbInfoPayload, SystemInfoPayload } from '../types';

import type { Section } from './settings/types';
import { SECTION_TABS, SettingsIcon, SidebarToggleIcon } from './settings/icons';
import { WikiPanel } from './settings/WikiPanel';
import { PromptLibraryPanel } from './settings/PromptLibraryPanel';
import { LlmPanel } from './settings/LlmPanel';
import { CustomPanel } from './settings/CustomPanel';
import { DbPanel } from './settings/DbPanel';
import { DevToolsPanel } from './settings/DevToolsPanel';
import { McpPanel } from './settings/McpPanel';
import { DmcrConfigPanel } from './settings/DmcrConfigPanel';
import { ThemePanel } from './settings/ThemePanel';
import { DangerRulesPanel } from './settings/DangerRulesPanel';
import GettingStartedPage from './GettingStartedPage';
import { ConvChipsPanel } from './settings/ConvChipsPanel';
import { AiFeaturesPanel } from './settings/AiFeaturesPanel';
import { SqlPoliciesPanel } from './settings/SqlPoliciesPanel';

interface Props {
  snapshot: SettingsSnapshot | null;
  onSnapshotChange: (s: SettingsSnapshot) => void;
  addToast: (msg: string, type?: ToastData['type']) => void;
  dbInfo?: DbInfoPayload | null;
  systemInfo?: SystemInfoPayload | null;
  aiFootprint?: { entries: CeAuditEntry[]; limit: number } | null;
  initialSection?: Section;
  onSectionChange?: (s: Section) => void;
  initialDevTool?: string;
  onDevToolChange?: (tool: string | undefined) => void;
  theme?: AppTheme;
  onThemeChange?: (t: AppTheme) => void;
}

export default function SettingsPage({ snapshot, onSnapshotChange, addToast, dbInfo, systemInfo, aiFootprint, initialSection, onSectionChange, initialDevTool, onDevToolChange, theme = 'dark', onThemeChange }: Props) {
  const [section, setSection] = useState<Section>(initialSection ?? 'getting-started');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [promptTarget, setPromptTarget] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);

  const handleSectionChange = (s: Section) => {
    setSection(s);
    onSectionChange?.(s);
  };

  if (!snapshot) {
    return (
      <div className="bs-settings-layout" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#64748b' }}>
          <span className="bs-spin" style={{ width: 24, height: 24, borderRadius: '50%', border: '2px solid transparent', borderTopColor: '#6366f1', display: 'block', margin: '0 auto 12px' }} />
          <p style={{ fontSize: 12, margin: 0 }}>Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bs-settings-layout">
      {/* Sidebar */}
      <nav className={`bs-settings-sidebar${sidebarCollapsed ? ' is-collapsed' : ''}`}>
        <div className="bs-settings-sidebar-head">
          <SettingsIcon className="bs-ico-sm" />
          <span className="bs-sidebar-label">Settings</span>
        </div>
        {SECTION_TABS.map(tab => (
          <button
            key={tab.id}
            className={`bs-settings-sidebar-item${section === tab.id ? ' is-active' : ''}`}
            onClick={() => handleSectionChange(tab.id)}
            title={sidebarCollapsed ? tab.label : undefined}
          >
            <tab.Icon className="bs-ico-sm" />
            <span className="bs-sidebar-label">{tab.label}</span>
          </button>
        ))}
        <div className="bs-sidebar-spacer" />
        <button
          className="bs-settings-sidebar-toggle"
          onClick={() => setSidebarCollapsed(c => !c)}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <SidebarToggleIcon className="bs-ico-sm" collapsed={sidebarCollapsed} />
          <span className="bs-sidebar-label">{sidebarCollapsed ? 'Expand' : 'Collapse'}</span>
        </button>
      </nav>

      {/* Content */}
      <div className="bs-settings-content">
        {section === 'getting-started' && <GettingStartedPage />}
        {section === 'quickref' && <WikiPanel />}
        {section === 'prompts'    && <PromptLibraryPanel addToast={addToast} initialScenario={promptTarget} />}
        {section === 'conv-chips' && <ConvChipsPanel addToast={addToast} />}
        {section === 'llm' && (
          <>
            <LlmPanel    snapshot={snapshot} onSnapshotChange={onSnapshotChange} addToast={addToast} />
            <CustomPanel snapshot={snapshot} onSnapshotChange={onSnapshotChange} addToast={addToast} />
          </>
        )}
        {section === 'db'     && <DbPanel     dbInfo={dbInfo} />}
        {section === 'devtools' && <DevToolsPanel systemInfo={systemInfo} aiFootprint={aiFootprint} dbInfo={dbInfo} initialActive={initialDevTool} onActiveChange={onDevToolChange} />}
        {section === 'mcp'    && <McpPanel />}
        {section === 'workspace' && <DmcrConfigPanel addToast={addToast} />}
        {section === 'theme' && <ThemePanel theme={theme} onThemeChange={onThemeChange} />}
        {section === 'danger' && <DangerRulesPanel addToast={addToast} />}
        {section === 'ai-features' && (
          <AiFeaturesPanel
            onGoToPrompts={(key) => {
              setPromptTarget(key);
              handleSectionChange('prompts');
            }}
          />
        )}
        {section === 'sql-policies' && <SqlPoliciesPanel addToast={addToast} />}
      </div>
    </div>
  );
}
