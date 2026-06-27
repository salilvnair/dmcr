import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { postMsg } from '../../vscode';
import type { ToastData } from '../../App';
import PillTabs from '../../components/PillTabs';
import '../PromptLibrary.css';

/* ── Scenarios that are registered in the Agent Pool (can be delegated to) ── */
const AGENT_POOL_SCENARIOS = new Set([
  'SQL_REFINE_AGENT', 'WIKI_AGENT', 'SQL_FAQ_AGENT', 'GENERAL_FAQ_AGENT',
  'GIT_COMMIT_MESSAGE', 'FREEFORM_SQL', 'SCHEMA_DIFF',
  'DMCR_RULES', 'ADD_COLUMNS', 'INSERT_ROWS', 'INTENT_DETECTOR',
  'REQUEST_PLANNER', 'FOLLOWUP_DECIDER', 'MASTER_AGENT', 'GREETING_AGENT',
  'MCP_AGENT', 'DIALOGUE_INTENT',
]);

/* ── Prompt categories for sidebar grouping ── */
const PROMPT_CATEGORIES = [
  {
    id: 'agents',
    label: 'Routing & Conversation',
    scenarios: ['DIALOGUE_INTENT', 'MASTER_AGENT', 'GREETING_AGENT', 'GENERAL_FAQ_AGENT', 'SQL_FAQ_AGENT', 'SQL_REFINE_AGENT', 'WIKI_AGENT', 'MCP_AGENT'],
  },
  {
    id: 'generation',
    label: 'SQL Generation',
    scenarios: ['DMCR_RULES', 'INTENT_DETECTOR', 'REQUEST_PLANNER', 'FOLLOWUP_DECIDER'],
  },
  {
    id: 'forms',
    label: 'Forms',
    scenarios: ['ADD_COLUMNS', 'INSERT_ROWS', 'FREEFORM_SQL', 'SCHEMA_DIFF'],
  },
  {
    id: 'devtools',
    label: 'Git & Version Control',
    scenarios: ['GIT_COMMIT_MESSAGE'],
  },
  {
    id: 'ai-features',
    label: 'AI Power Features',
    scenarios: [
      'AI_CHANGE_EXPLAINER', 'AI_RISK_SCORER', 'AI_SCHEMA_DOCUMENTER',
      'AI_ROLLBACK_ADVISOR', 'AI_DEPENDENCY_ANALYZER', 'AI_CHANGELOG_GENERATOR',
      'AI_DEAD_COLUMN_DETECTOR', 'AI_SQL_POLICY_GUARD', 'AI_SEMANTIC_VERSION',
      'AI_DRIFT_DETECTIVE', 'AI_TEST_DATA_GENERATOR', 'AI_PERF_PREDICTOR',
      'AI_PROMOTION_GATEKEEPER', 'AI_ENV_DIFF_EXPLAINER', 'AI_PROMOTION_ORDER',
      'AI_BLAST_RADIUS', 'AI_BLUE_GREEN_PLAN', 'AI_POST_DEPLOY_HEALTH',
      'AI_COMPLIANCE_CHECKER', 'AI_CONFLICT_RESOLVER', 'AI_CANARY_ADVISOR',
      'AI_TICKET_LINKER',
    ],
  },
];

/* ── Per-scenario SVG icons for block palette ── */
function PromptBlockSvg({ scenario }: { scenario: string }) {
  switch (scenario) {
    case 'MASTER_AGENT':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>;
    case 'GREETING_AGENT':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>;
    case 'GENERAL_FAQ_AGENT':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
    case 'SQL_FAQ_AGENT':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>;
    case 'SQL_REFINE_AGENT':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/><path d="M15 5l4 4"/></svg>;
    case 'WIKI_AGENT':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>;
    case 'MCP_AGENT':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>;
    case 'GIT_COMMIT_MESSAGE':
      return <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>;
    case 'DIALOGUE_INTENT':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>;
    case 'DMCR_RULES':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
    case 'INTENT_DETECTOR':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
    case 'REQUEST_PLANNER':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>;
    case 'FOLLOWUP_DECIDER':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case 'FREEFORM_SQL':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>;
    case 'SCHEMA_DIFF':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>;
    case 'ADD_COLUMNS':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>;
    case 'INSERT_ROWS':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    default:
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
  }
}

type VariableInfo = { description: string; source: string };
type ScenarioVarMap = Record<string, VariableInfo>;
type PromptLibraryEntry = {
  scenario: string;
  label: string;
  description: string;
  prompt: string;
  userPrompt: string;
  agentName: string;
  isCustomized: boolean;
  variables: ScenarioVarMap;
  updatedAt: string | null;
};

export function PromptLibraryPanel({ addToast, initialScenario }: { addToast: (msg: string, type?: ToastData['type']) => void; initialScenario?: string }) {
  const [entries, setEntries] = useState<PromptLibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editUserText, setEditUserText] = useState('');
  const [editAgentName, setEditAgentName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingScenario, setPendingScenario] = useState<string | null>(null);
  const [editingAgentName, setEditingAgentName] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [editorTab, setEditorTab] = useState<'edit' | 'preview'>('preview');
  const [promptRole, setPromptRole] = useState<'system' | 'user'>('system');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const userTextareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Resizable sidebar ──
  const PL_MIN_W = 220;
  const PL_MAX_W = 480;
  const PL_DEFAULT_W = 280;
  const [sidebarWidth, setSidebarWidth] = useState(PL_DEFAULT_W);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [showSplitterTip, setShowSplitterTip] = useState(false);
  const splitterDrag = useRef({ active: false, startX: 0, startW: PL_DEFAULT_W, moved: false });

  const onSplitterPointerDown = useCallback((e: React.PointerEvent) => {
    splitterDrag.current = { active: true, startX: e.clientX, startW: sidebarWidth, moved: false };
    setSidebarDragging(true);
    e.preventDefault();
  }, [sidebarWidth]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!splitterDrag.current.active) return;
      const dx = e.clientX - splitterDrag.current.startX;
      if (Math.abs(dx) > 3) splitterDrag.current.moved = true;
      setSidebarWidth(Math.max(PL_MIN_W, Math.min(PL_MAX_W, splitterDrag.current.startW + dx)));
    }
    function onUp() {
      if (!splitterDrag.current.active) return;
      const moved = splitterDrag.current.moved;
      splitterDrag.current.active = false;
      setSidebarDragging(false);
      if (!moved) setSidebarOpen(o => !o);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, []);

  // Keyboard: Alt+B toggles sidebar
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        setSidebarOpen(o => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    postMsg({ type: 'loadPromptLibrary' });
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'promptLibraryLoaded') {
        setEntries(msg.payload as PromptLibraryEntry[]);
        setLoading(false);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // When navigated here from 📖 in AI Features panel, activate the target scenario
  const initialScenarioApplied = useRef(false);
  useEffect(() => {
    if (!initialScenario || loading || entries.length === 0 || initialScenarioApplied.current) return;
    const entry = entries.find(e => e.scenario === initialScenario);
    if (entry) {
      initialScenarioApplied.current = true;
      setActiveScenario(initialScenario);
      setEditText(entry.prompt);
      setEditUserText(entry.userPrompt ?? '');
      setEditAgentName(entry.agentName ?? '');
      setDirty(false);
      // Expand the AI Features group if collapsed
      setCollapsedGroups(prev => { const next = new Set(prev); next.delete('ai-features'); return next; });
    }
  }, [initialScenario, entries, loading]);

  // Reset applied flag when target changes so re-navigation works
  useEffect(() => { initialScenarioApplied.current = false; }, [initialScenario]);

  const activeEntry = useMemo(() => entries.find(e => e.scenario === activeScenario), [entries, activeScenario]);

  const handleSelect = useCallback((scenario: string) => {
    if (dirty) { setPendingScenario(scenario); return; }
    const entry = entries.find(e => e.scenario === scenario);
    if (entry) {
      setActiveScenario(scenario);
      setEditText(entry.prompt);
      setEditUserText(entry.userPrompt);
      setEditAgentName(entry.agentName);
      setDirty(false);
      setEditingAgentName(false);
      setPromptRole('system');
      setEditorTab('preview');
    }
  }, [entries, dirty]);

  const confirmDiscard = useCallback(() => {
    const scenario = pendingScenario;
    if (!scenario) return;
    setPendingScenario(null);
    setDirty(false);
    const entry = entries.find(e => e.scenario === scenario);
    if (entry) {
      setActiveScenario(scenario);
      setEditText(entry.prompt);
      setEditUserText(entry.userPrompt);
      setEditAgentName(entry.agentName);
      setEditingAgentName(false);
      setPromptRole('system');
      setEditorTab('preview');
    }
  }, [pendingScenario, entries]);

  const handleSave = useCallback(() => {
    if (!activeScenario || !activeEntry) return;
    // Merge known vars + any extra {{...}} discovered in prompt text
    const bothText = editText + '\n' + editUserText;
    const extraKeys = (bothText.match(/\{\{\s*([^}]+?)\s*\}\}/g) || [])
      .map(m => m.replace(/^\{\{\s*|\s*\}\}$/g, ''))
      .filter((k, idx, arr) => arr.indexOf(k) === idx && !(k in activeEntry.variables));
    const mergedVars: ScenarioVarMap = { ...activeEntry.variables };
    for (const k of extraKeys) mergedVars[k] = { description: 'Template variable', source: 'prompt text' };
    postMsg({ type: 'savePromptLibrary', payload: { scenario: activeScenario, prompt: editText, userPrompt: editUserText, agentName: editAgentName, variables: mergedVars } });
    setDirty(false);
    addToast('Prompt saved', 'ok');
  }, [activeScenario, activeEntry, editText, editUserText, editAgentName, addToast]);

  const handleReset = useCallback(() => {
    if (!activeScenario) return;
    postMsg({ type: 'resetPromptLibrary', payload: { scenario: activeScenario } });
    setDirty(false);
    addToast('Prompt reset to default', 'ok');
  }, [activeScenario, addToast]);

  const insertVariable = useCallback((varName: string) => {
    const ta = promptRole === 'system' ? textareaRef.current : userTextareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const currentText = promptRole === 'system' ? editText : editUserText;
    const newText = currentText.slice(0, start) + varName + currentText.slice(end);
    if (promptRole === 'system') setEditText(newText);
    else setEditUserText(newText);
    setDirty(true);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + varName.length, start + varName.length);
    }, 0);
  }, [editText, editUserText, promptRole]);

  useEffect(() => {
    if (activeEntry && !dirty) {
      setEditText(activeEntry.prompt);
      setEditUserText(activeEntry.userPrompt);
      setEditAgentName(activeEntry.agentName);
    }
  }, [activeEntry, dirty]);

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsedGroups(new Set()), []);
  const collapseAll = useCallback(() => {
    const allGroups = new Set(PROMPT_CATEGORIES.map(c => c.id));
    setCollapsedGroups(allGroups);
  }, []);

  // Category config with colors — saturated badge colors (GitHub/VS Code style)
  const categoryColors: Record<string, string> = {
    'DMCR_RULES': '#3b82f6',
    'INTENT_DETECTOR': '#7c3aed',
    'REQUEST_PLANNER': '#8b5cf6',
    'FOLLOWUP_DECIDER': '#ea580c',
    'FREEFORM_SQL': '#16a34a',
    'SCHEMA_DIFF': '#0891b2',
    'ADD_COLUMNS': '#0d9488',
    'INSERT_ROWS': '#059669',
    'MASTER_AGENT': '#dc2626',
    'GREETING_AGENT': '#65a30d',
    'GENERAL_FAQ_AGENT': '#0284c7',
    'SQL_FAQ_AGENT': '#1d4ed8',
    'SQL_REFINE_AGENT': '#be123c',
    'WIKI_AGENT': '#4f46e5',
    'MCP_AGENT': '#9333ea',
    'GIT_COMMIT_MESSAGE': '#7c3aed',
    'DIALOGUE_INTENT': '#0f766e',
    // AI Power Features
    'AI_CHANGE_EXPLAINER': '#6366f1',
    'AI_RISK_SCORER': '#f59e0b',
    'AI_SCHEMA_DOCUMENTER': '#0891b2',
    'AI_ROLLBACK_ADVISOR': '#dc2626',
    'AI_DEPENDENCY_ANALYZER': '#7c3aed',
    'AI_CHANGELOG_GENERATOR': '#16a34a',
    'AI_DEAD_COLUMN_DETECTOR': '#d97706',
    'AI_SQL_POLICY_GUARD': '#0d9488',
    'AI_SEMANTIC_VERSION': '#8b5cf6',
    'AI_DRIFT_DETECTIVE': '#ea580c',
    'AI_TEST_DATA_GENERATOR': '#059669',
    'AI_PERF_PREDICTOR': '#eab308',
    'AI_PROMOTION_GATEKEEPER': '#6366f1',
    'AI_ENV_DIFF_EXPLAINER': '#3b82f6',
    'AI_PROMOTION_ORDER': '#a855f7',
    'AI_BLAST_RADIUS': '#ef4444',
    'AI_BLUE_GREEN_PLAN': '#06b6d4',
    'AI_POST_DEPLOY_HEALTH': '#10b981',
    'AI_COMPLIANCE_CHECKER': '#f97316',
    'AI_CONFLICT_RESOLVER': '#8b5cf6',
    'AI_CANARY_ADVISOR': '#84cc16',
    'AI_TICKET_LINKER': '#64748b',
  };

  const getColor = (scenario: string) => categoryColors[scenario] || '#6366f1';

  /** Render prompt text with {{variables}} highlighted as inline pills */
  const renderPreview = useCallback((text: string, vars: ScenarioVarMap) => {
    // Split on {{...}} patterns — highlight ALL template vars, not just known ones
    const parts = text.split(/(\{\{[^}]+\}\})/g);
    return parts.map((part, i) => {
      const m = part.match(/^\{\{\s*(.+?)\s*\}\}$/);
      if (m) {
        const key = m[1];
        const v = vars[key];
        return (
          <span key={i} className="pl-preview-var" title={v ? `{{${key}}}  (string | undefined)\n${v.description}\nSource: ${v.source}` : part}>
            {part}
          </span>
        );
      }
      // Render plain text preserving newlines
      return <span key={i}>{part}</span>;
    });
  }, []);

  // Group entries by category
  const grouped = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const filtered = q ? entries.filter(e =>
      e.label.toLowerCase().includes(q) ||
      e.scenario.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.agentName.toLowerCase().includes(q)
    ) : entries;

    return PROMPT_CATEGORIES.map(cat => ({
      ...cat,
      items: cat.scenarios
        .map(s => filtered.find(e => e.scenario === s))
        .filter((e): e is NonNullable<typeof e> => !!e),
    })).filter(cat => cat.items.length > 0);
  }, [entries, searchQuery]);

  if (loading) {
    return (
      <div className="prompt-lib" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="prompt-lib-loading">
          <div className="prompt-lib-loading-spinner" />
          Loading prompt library...
        </div>
      </div>
    );
  }

  return (
    <div className={`prompt-lib${sidebarDragging ? ' is-dragging' : ''}`}>
      {/* ── Left sidebar: blocks-style ── */}
      <div className="pl-sidebar" style={{ width: sidebarOpen ? sidebarWidth : 0 }}>
        {/* Search */}
        <div className="pl-search-wrap">
          <svg className="pl-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            className="pl-search-input"
            type="text"
            placeholder="Search prompts..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="pl-search-clear" onClick={() => setSearchQuery('')} title="Clear search">×</button>
          )}
        </div>

        {/* Toolbar: expand/collapse all */}
        <div className="pl-toolbar">
          <button className="pl-toolbar-btn" onClick={expandAll} title="Expand all">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>
            </svg>
          </button>
          <button className="pl-toolbar-btn" onClick={collapseAll} title="Collapse all">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>
            </svg>
          </button>
        </div>

        {/* Block list */}
        <div className="pl-block-list">
          {grouped.map(cat => {
            const isOpen = !collapsedGroups.has(cat.id);
            return (
              <div className="pl-group" key={cat.id}>
                <button className="pl-group-toggle" onClick={() => toggleGroup(cat.id)}>
                  <svg className={`pl-group-chevron${isOpen ? '' : ' collapsed'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                  <span className="pl-group-label">{cat.label}</span>
                  <span className="pl-group-count">{cat.items.length}</span>
                </button>
                {isOpen && (
                  <div className="pl-group-items">
                    {cat.items.map(entry => (
                      <button
                        key={entry.scenario}
                        className={`pl-block-item${activeScenario === entry.scenario ? ' active' : ''}`}
                        onClick={() => handleSelect(entry.scenario)}
                      >
                        <div className="pl-block-icon" style={{ background: getColor(entry.scenario) }}>
                          <PromptBlockSvg scenario={entry.scenario} />
                        </div>
                        <div className="pl-block-meta">
                          <div className="pl-block-name">
                            {entry.agentName || entry.label}
                            {entry.isCustomized && <span className="pl-block-badge">edited</span>}
                            <span className="pl-scenario-chip pl-scenario-chip--inline" style={{ background: getColor(entry.scenario), color: '#fff', borderColor: getColor(entry.scenario) }}>{entry.scenario}</span>
                            {AGENT_POOL_SCENARIOS.has(entry.scenario) && (
                              <span className="pl-scenario-chip pl-scenario-chip--pool">🤖</span>
                            )}
                          </div>
                          <div className="pl-block-desc">{entry.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Splitter: drag to resize, click to collapse ── */}
      <div
        className={`pl-splitter${!sidebarOpen ? ' is-collapsed' : ''}`}
        onPointerDown={onSplitterPointerDown}
        onMouseEnter={() => setShowSplitterTip(true)}
        onMouseLeave={() => setShowSplitterTip(false)}
        aria-label="Resize or collapse sidebar"
      >
        <div className="pl-splitter-grip" />
        {showSplitterTip && !sidebarDragging && (
          <div className="pl-splitter-tip">
            <div>Click to {sidebarOpen ? 'collapse' : 'expand'} <kbd>Alt+B</kbd></div>
            <div>Drag to resize</div>
          </div>
        )}
      </div>

      {/* ── Right editor pane ── */}
      <div className="pl-editor-pane">
        {activeEntry ? (
          <>
            {/* Header bar */}
            <div className="pl-editor-header">
              <div className="pl-editor-header-left">
                <h3 className="pl-editor-title">
                  {activeEntry.label}
                  <span className="pl-scenario-chip pl-scenario-chip--inline" style={{ background: getColor(activeEntry.scenario), color: '#fff', borderColor: getColor(activeEntry.scenario) }}>{activeEntry.scenario}</span>
                  {AGENT_POOL_SCENARIOS.has(activeEntry.scenario) && (
                    <span className="pl-scenario-chip pl-scenario-chip--pool">🤖 Agent Pool</span>
                  )}
                </h3>
                <p className="pl-editor-desc">{activeEntry.description}</p>
                {activeEntry.updatedAt && (
                  <p className="pl-editor-time">Modified: {new Date(activeEntry.updatedAt).toLocaleString()}</p>
                )}
              </div>
              <div className="pl-editor-header-right">
                <button className="pl-btn pl-btn-save" onClick={handleSave} disabled={!dirty}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  Save
                </button>
                <button className="pl-btn pl-btn-reset" onClick={handleReset} disabled={!activeEntry.isCustomized}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                  Reset
                </button>
              </div>
            </div>

            {/* Agent name — inline edit with pencil */}
            <div className="pl-agent-name-bar">
              <span className="pl-agent-name-label">Agent Name</span>
              {editingAgentName ? (
                <input
                  autoFocus
                  className="pl-agent-name-input"
                  value={editAgentName}
                  onChange={e => { setEditAgentName(e.target.value); setDirty(true); }}
                  onBlur={() => setEditingAgentName(false)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.currentTarget.blur(); }
                    if (e.key === 'Escape') { setEditingAgentName(false); }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="pl-agent-name-display"
                  onClick={() => setEditingAgentName(true)}
                  onDoubleClick={() => setEditingAgentName(true)}
                  title="Click to rename agent"
                >
                  <span>{editAgentName || 'Unnamed Agent'}</span>
                  <svg className="pl-agent-name-pencil" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9"/>
                    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                  </svg>
                </button>
              )}
            </div>

            {/* Prompt role tabs (System / User) + editor tabs (Edit / Preview) */}
            <div className="pl-tab-bar">
              <PillTabs
                tabs={[
                  { id: 'system', label: '🔧 System' },
                  { id: 'user', label: '💬 User' },
                ]}
                active={promptRole}
                onChange={(id) => setPromptRole(id as 'system' | 'user')}
                size="sm"
              />
              <PillTabs
                tabs={[
                  { id: 'preview', label: '👁 Preview' },
                  { id: 'edit', label: '✏️ Edit' },
                ]}
                active={editorTab}
                onChange={(id) => setEditorTab(id as 'edit' | 'preview')}
                size="sm"
              />
            </div>

            {/* Variables ribbon — all known vars + any extra {{...}} found in both prompts */}
            {(() => {
              const bothText = editText + '\n' + editUserText;
              // Extra vars in prompt text that aren't in the known map
              const extraKeys = (bothText.match(/\{\{\s*([^}]+?)\s*\}\}/g) || [])
                .map(m => m.replace(/^\{\{\s*|\s*\}\}$/g, ''))
                .filter((k, idx, arr) => arr.indexOf(k) === idx && !(k in activeEntry.variables));
              const allVars: ScenarioVarMap = { ...activeEntry.variables };
              for (const k of extraKeys) allVars[k] = { description: 'Template variable', source: 'prompt text' };
              const keys = Object.keys(allVars);
              return keys.length > 0 ? (
                <div className="pl-vars-ribbon">
                  <span className="pl-vars-label">Variables — click to insert:</span>
                  {keys.map(k => {
                    const v = allVars[k];
                    return (
                      <button
                        key={k}
                        className="pl-var-pill"
                        onClick={() => { setEditorTab('edit'); insertVariable(`{{${k}}}`); }}
                        title={`{{${k}}}  (string | undefined)\n${v.description}\nSource: ${v.source}`}
                      >
                        {`{{${k}}}`}
                      </button>
                    );
                  })}
                </div>
              ) : null;
            })()}

            {/* Editor / Preview area */}
            {editorTab === 'edit' ? (
              <div className="pl-textarea-wrap">
                {promptRole === 'system' ? (
                  <textarea
                    ref={textareaRef}
                    className="pl-textarea"
                    value={editText}
                    onChange={e => { setEditText(e.target.value); setDirty(true); }}
                    spellCheck={false}
                  />
                ) : (
                  <textarea
                    ref={userTextareaRef}
                    className="pl-textarea"
                    value={editUserText}
                    onChange={e => { setEditUserText(e.target.value); setDirty(true); }}
                    spellCheck={false}
                  />
                )}
                {dirty && <div className="pl-dirty-indicator">● unsaved</div>}
              </div>
            ) : (
              <div className="pl-preview-wrap">
                <div className="pl-preview-content">
                  {renderPreview(promptRole === 'system' ? editText : editUserText, activeEntry.variables)}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="pl-empty">
            <svg viewBox="0 0 24 24" fill="none" width="48" height="48" className="pl-empty-icon">
              <path d="M12 2L9.5 9 2 10.5l5.5 4.5L5.5 22 12 18l6.5 4-2-7.5L22 10.5 14.5 9z" stroke="url(#plGrad)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" fill="url(#plGrad)" fillOpacity="0.08"/>
              <defs><linearGradient id="plGrad" x1="2" y1="2" x2="22" y2="22"><stop stopColor="#6366f1"/><stop offset="1" stopColor="#ec4899"/></linearGradient></defs>
            </svg>
            <p className="pl-empty-title">Select a prompt</p>
            <p className="pl-empty-sub">Pick a prompt from the sidebar to view, edit, and customize how DMCR's AI agents behave.</p>
          </div>
        )}
      </div>

      {/* ── Unsaved changes guard modal ── */}
      {pendingScenario && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}>
          <div style={{ background: 'var(--bg-primary, #0f172a)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '24px 28px', maxWidth: 380, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary, #e2e8f0)', marginBottom: 8 }}>Unsaved changes</div>
            <p style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6, margin: '0 0 20px' }}>
              You have unsaved changes to this prompt. Navigating away will discard them.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="bs-btn-sm bs-btn-primary"
                style={{ background: '#ef4444', borderColor: '#ef4444' }}
                onClick={confirmDiscard}
              >Discard &amp; Continue</button>
              <button className="bs-btn-sm bs-btn-ghost" onClick={() => setPendingScenario(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
