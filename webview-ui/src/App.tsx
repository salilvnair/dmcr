import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { postMsg } from './vscode';
import type { AppTheme, ExtMsg, SettingsSnapshot, GenState, DbInfoPayload, SystemInfoPayload, CeAuditEntry, UiSnapshot, FormSnapshot, CustomProviderConfig } from './types';
import HomePage from './pages/HomePage';
import SettingsPage from './pages/SettingsPage';
import RunnerPage, { type RunnerHandle } from './pages/runner';
import ConversationPage from './pages/ConversationPage';
import DdlPage from './pages/DdlPage';
import InsertPage from './pages/InsertPage';
import FreeformPage from './pages/FreeformPage';
import SchemaDiffPage from './pages/SchemaDiffPage';
import GettingStartedPage from './pages/GettingStartedPage';
import Toast from './components/Toast';
import { useContextMenu } from './components/ContextMenu';

type Tab = 'home' | 'ddl' | 'insert' | 'freeform' | 'schema_diff' | 'schema_explorer' | 'conversation' | 'runner' | 'settings';
type ResettableFormTab = 'ddl' | 'insert' | 'freeform' | 'schema_diff';

export type ToastData = { id: number; message: string; type: 'ok' | 'error' | 'warn' };

let _toastId = 0;

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const [devToolActive, setDevToolActive] = useState<string | undefined>(undefined);
  const [formSnapshot, setFormSnapshot] = useState<FormSnapshot>({});
  const [formResetKeys, setFormResetKeys] = useState<Record<ResettableFormTab, number>>({
    ddl: 0,
    insert: 0,
    freeform: 0,
    schema_diff: 0,
  });
  /** Ref mirror of `tab` so message handlers always read the current value */
  const currentTabRef = useRef<string>('home');
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [appTheme, setAppTheme] = useState<AppTheme>('dark');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const effectiveDark = useMemo(
    () => appTheme === 'dark' ? true : appTheme === 'light' ? false : systemDark,
    [appTheme, systemDark]
  );
  const effectiveDarkRef = useRef(effectiveDark);
  const [genState, setGenState] = useState<GenState>({ status: 'idle' });
  /** Per-form generating state for tab spinner indicators */
  const [generatingForms, setGeneratingForms] = useState<Set<string>>(new Set());
  /** Forms that finished generating while the user was on another tab — show a green ready badge */
  const [readyTabs, setReadyTabs] = useState<Set<string>>(new Set());
  /** True while DMCR Assistant has an in-flight chat request */
  const [chatBusy, setChatBusy] = useState(false);
  /** Available schemas from all DB MCP servers */
  const [availableSchemas, setAvailableSchemas] = useState<string[]>([]);
  const [existingChanges, setExistingChanges] = useState<string[]>([]);
  const [hasDbMcp, setHasDbMcp] = useState(false);
  const [recentForms, setRecentForms] = useState<string[]>([]);
  const [changesDir, setChangesDir] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [dbInfo, setDbInfo] = useState<DbInfoPayload | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfoPayload | null>(null);
  const [aiFootprint, setAiFootprint] = useState<{ entries: CeAuditEntry[]; limit: number } | null>(null);
  /** Tracks which form tab is currently visible/active */
  const activeFormTabRef  = useRef<'ddl'|'insert'|'freeform'|'schema_diff'|null>(null);
  /** Topbar tab scroll arrows */
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const updateTabScrollBtns = useCallback(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 4;
    setTabsOverflow(overflow);
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);
  useEffect(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    updateTabScrollBtns();
    el.addEventListener('scroll', updateTabScrollBtns, { passive: true });
    const ro = new ResizeObserver(updateTabScrollBtns);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', updateTabScrollBtns); ro.disconnect(); };
  }, [updateTabScrollBtns]);
  const scrollTabs = (dir: 'left' | 'right') => {
    tabsScrollRef.current?.scrollBy({ left: dir === 'right' ? 150 : -150, behavior: 'smooth' });
  };
  /** Set of forms currently running a generation — supports parallel submissions */
  const generatingFormsRef = useRef<Set<string>>(new Set());
  /** Handle to the xterm instance in RunnerPage */
  const runnerRef    = useRef<RunnerHandle | null>(null);
  const didApplyInitialSnapshotRef = useRef(false);

  const addToast = useCallback((message: string, type: ToastData['type'] = 'ok') => {
    const id = ++_toastId;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  /* Bootstrap: request initial state on mount */
  useEffect(() => {
    postMsg({ type: 'ready' });
    postMsg({ type: 'getDbMcpStatus' });
    postMsg({ type: 'discoverAllDbSchemas' });
    postMsg({ type: 'listExistingChanges' });
    postMsg({ type: 'getDmcrConfig' });
  }, []);

  /* Expose current UI state for DebugPanel diagnostics */
  useEffect(() => {
    (window as any).__dmcrUiSnapshot = { tab, theme: appTheme, settingsSection, devToolActive, formState: formSnapshot };
  }, [tab, appTheme, settingsSection, devToolActive, formSnapshot]);

  /* Save UI snapshot whenever active tab, theme, settings section, or form fields change (debounced 1.5s) */
  useEffect(() => {
    const timer = setTimeout(() => {
      postMsg({
        type: 'saveUiSnapshot',
        payload: { tab, theme: appTheme, settingsSection, devToolActive, formState: formSnapshot } as UiSnapshot,
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [tab, appTheme, settingsSection, devToolActive, formSnapshot]);

  const handleFormStateChange = useCallback((form: keyof FormSnapshot, patch: FormSnapshot[keyof FormSnapshot]) => {
    setFormSnapshot(prev => ({ ...prev, [form]: { ...(prev[form] as object ?? {}), ...(patch as object) } }));
  }, []);

  /* Keep effectiveDarkRef in sync; also stamp data-theme on <html> so portaled elements inherit CSS vars */
  useEffect(() => {
    effectiveDarkRef.current = effectiveDark;
    document.documentElement.dataset.theme = effectiveDark ? 'dark' : 'light';
  }, [effectiveDark]);

  /* Listen for OS theme changes (for 'system' mode) */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  /* Keep currentTabRef in sync with tab state */
  useEffect(() => { currentTabRef.current = tab; }, [tab]);

  /* -- Message handler (extension -> webview) -- */
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtMsg;
      switch (msg.type) {
        case 'init':
          setSnapshot(msg.payload);
          if (msg.payload.theme) setAppTheme(msg.payload.theme);
          // Restore UI snapshot only once on initial bootstrap.
          // Do not re-apply in the background after the user has already navigated.
          if (!didApplyInitialSnapshotRef.current && msg.payload.uiSnapshot) {
            didApplyInitialSnapshotRef.current = true;
            const snap = msg.payload.uiSnapshot as UiSnapshot;
            if (snap.tab && snap.tab !== 'home') {
              setTab(snap.tab as Tab);
            }
            if (snap.settingsSection) setSettingsSection(snap.settingsSection);
            if (snap.devToolActive) setDevToolActive(snap.devToolActive);
            if (snap.formState) setFormSnapshot(snap.formState as FormSnapshot);
          }
          break;

        case 'saved':
          if (msg.payload?.folderId) {
            // Form save — React form pages listen on window directly.
            // A new change folder exists: refresh the "Requires" pickers.
            postMsg({ type: 'listExistingChanges' });
          } else {
            // Settings save
            setSnapshot(prev => prev
              ? { ...prev, activeProvider: msg.payload.activeProvider ?? prev.activeProvider, activeFamily: msg.payload.activeFamily ?? prev.activeFamily }
              : prev
            );
            addToast('Settings saved', 'ok');
          }
          break;

        case 'providerAdded': {
          const p = msg.payload;
          setSnapshot(prev => {
            if (!prev) return prev;
            const existing = prev.customProviders.findIndex(x => x.key === p.key);
            const entry = {
              key: p.key, name: p.name,
              type: p.type as CustomProviderConfig['type'],
              chatUrl: '', modelsUrl: '', headers: {},
              activeModel: p.activeModel ?? '',
              cachedModels: p.models ?? [],
            };
            const providers = [...prev.customProviders];
            if (existing >= 0) providers[existing] = entry;
            else providers.push(entry);
            return { ...prev, customProviders: providers };
          });
          addToast(`Provider "${p.name}" added`, 'ok');
          break;
        }

        case 'providerDeleted': {
          const { key } = msg.payload;
          setSnapshot(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              customProviders: prev.customProviders.filter(p => p.key !== key),
              activeProvider: prev.activeProvider === key ? 'copilot' : prev.activeProvider,
            };
          });
          addToast('Provider removed', 'ok');
          break;
        }

        case 'modelsFetched': {
          const { key, models } = msg.payload;
          setSnapshot(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              customProviders: prev.customProviders.map(p =>
                p.key === key ? { ...p, cachedModels: models } : p
              ),
            };
          });
          addToast(`Fetched ${msg.payload.models.length} model(s)`, 'ok');
          break;
        }

        case 'formCancelled': {
          const cancelledForm = msg.payload?.form as Tab | undefined;
          const goHome = !!msg.payload?.goHome;
          const reset = !!msg.payload?.reset;
          activeFormTabRef.current = null;
          setGenState({ status: 'idle' });
          if (goHome) {
            setTab('home');
            break;
          }
          if (cancelledForm && ['ddl', 'insert', 'freeform', 'schema_diff'].includes(cancelledForm)) {
            if (reset) {
              setFormResetKeys(prev => ({
                ...prev,
                [cancelledForm]: prev[cancelledForm as ResettableFormTab] + 1,
              }));
            }
            setTab(cancelledForm);
          }
          break;
        }

        /* ── Form messages — React form pages listen on window directly ── */

        case 'showProgress':
        case 'progressUpdate':
        case 'streamChunk':
        case 'folderPicked':
        case 'saveError':
          // React form pages listen on window directly — no forwarding needed
          break;

        case 'lintResult':
          // React form pages and ChangeCard listen on window directly
          break;

        // reply / sseEvent — ConversationPage listens on window directly, no forwarding needed

        case 'generating': {
          const gForm = msg.payload.form as string;
          generatingFormsRef.current.add(gForm);
          activeFormTabRef.current = gForm as 'ddl'|'insert'|'freeform'|'schema_diff';
          setGeneratingForms(prev => { const s = new Set(prev); s.add(gForm); return s; });
          setGenState({ status: 'running', form: gForm });
          break;
        }

        case 'generationDone': {
          const doneForm = msg.payload?.form as string | undefined;
          if (doneForm) {
            generatingFormsRef.current.delete(doneForm);
            setGeneratingForms(prev => { const s = new Set(prev); s.delete(doneForm); return s; });
            // Badge the tab if user isn't currently looking at it
            if (currentTabRef.current !== doneForm) {
              setReadyTabs(prev => { const s = new Set(prev); s.add(doneForm); return s; });
            }
          }
          setGenState(generatingFormsRef.current.size > 0
            ? { status: 'running', form: [...generatingFormsRef.current][0] }
            : { status: 'done', folderId: msg.payload.folderId ?? '', folderRel: msg.payload.folderRel ?? '', isDanger: !!msg.payload.isDanger });
          if (msg.payload.folderId) {
            // Save confirmation — toast only; the form already shows the card
            addToast(
              msg.payload.isDanger
                ? `[!] ${msg.payload.folderId} (danger  -  manual deploy)`
                : `OK  Created ${msg.payload.folderId}`,
              msg.payload.isDanger ? 'warn' : 'ok',
            );
          }
          // React form pages listen on window directly — no forwarding needed
          break;
        }

        case 'generationError': {
          const errForm = msg.payload?.form as string | undefined;
          if (errForm) {
            generatingFormsRef.current.delete(errForm);
            setGeneratingForms(prev => { const s = new Set(prev); s.delete(errForm); return s; });
          }
          setGenState(generatingFormsRef.current.size > 0
            ? { status: 'running', form: [...generatingFormsRef.current][0] }
            : { status: 'idle' });
          addToast(msg.payload.message, 'error');
          // React form pages listen on window directly — no forwarding needed
          break;
        }

        case 'sqliteRebuildResult': {
          const { ok, error, building } = msg.payload;
          if (building) {
            addToast('Rebuilding SQLite... this may take a minute', 'warn');
          } else if (ok) {
            setSnapshot(prev => prev ? { ...prev, sqliteStatus: 'ok' } : prev);
            addToast('SQLite rebuilt  -  click "Restart Now" in the notification', 'ok');
          } else if (error !== null) {
            addToast(`SQLite rebuild failed: ${error?.slice(0, 80)}`, 'error');
          }
          break;
        }

        case 'dbInfo':
          setDbInfo(msg.payload);
          break;

        case 'allDbSchemas':
          setAvailableSchemas(msg.payload?.schemas ?? []);
          setHasDbMcp((msg.payload?.schemas ?? []).length > 0);
          break;

        case 'existingChanges':
          setExistingChanges(msg.payload?.changes ?? []);
          break;

        case 'dbMcpStatus': {
          const hasDb = !!(msg.payload as any)?.hasDbMcp;
          setHasDbMcp(hasDb);
          // Re-fetch schemas whenever DB MCP status changes
          if (hasDb) postMsg({ type: 'discoverAllDbSchemas' });
          else setAvailableSchemas([]);
          break;
        }

        case 'systemInfo':
          setSystemInfo(msg.payload);
          break;

        case 'aiFootprint':
          setAiFootprint(msg.payload);
          break;

        case 'aiFootprintLimitSaved':
          setAiFootprint(prev => prev && msg.payload.keepLimit ? { ...prev, limit: msg.payload.keepLimit } : prev);
          addToast('AI Footprint limit saved', 'ok');
          break;

        // __dmcr_chatBusy — posted by ConversationPage fetch bridge to track DMCR Assistant tab dot
        case '__dmcr_chatBusy' as any: {
          const isBusy = !!(msg as any).busy;
          setChatBusy(isBusy);
          // Badge conversation tab when chat finishes and user isn't on it
          if (!isBusy && currentTabRef.current !== 'conversation') {
            setReadyTabs(prev => { const s = new Set(prev); s.add('conversation'); return s; });
          }
          break;
        }

        // reply / sseEvent — ConversationPage listens on window directly, no forwarding needed
        case 'reply':
          break;

        case 'error':
          // Conversation errors (msgId) handled directly by ConversationPage; generic errors toasted
          if (!msg.msgId) addToast(msg.payload, 'error');
          break;

        case 'terminalData':
          // Stream chunk from dmcr.ps1 → xterm in RunnerPage
          runnerRef.current?.write(msg.payload as string);
          break;

        case 'terminalExit': {
          // Process finished — notify RunnerPage to re-enable buttons
          const { code, expected } = msg.payload as { code: number | null; expected?: boolean };
          const ok = code === 0 || code === null;
          runnerRef.current?.writeln('');
          if (!expected) {
            // Only show footer line for actual process exits (not pre-handled config errors)
            runnerRef.current?.writeln(
              ok
                ? '\x1b[38;2;74;222;128m── Done \u2713 \x1b[38;2;71;85;105m────────────────────────────────────────────────\x1b[0m'
                : `\x1b[38;2;248;113;113m── Error: process exited with code ${code} \x1b[38;2;71;85;105m────────────────────────\x1b[0m`
            );
            runnerRef.current?.writeln('');
          }
          // Signal RunnerPage component via the global shim
          const setter = (window as unknown as { __dmcrRunnerSetRunning?: (v: boolean, err?: boolean) => void }).__dmcrRunnerSetRunning;
          setter?.(false, !ok);
          break;
        }

        case 'navigateToTab' as any: {
          const targetTab = (msg as any).payload?.tab as Tab | undefined;
          if (targetTab) handleTabChange(targetTab);
          break;
        }

        case 'dmcrConfig' as any: {
          const cfg = (msg as any).payload;
          if (cfg) setChangesDir(cfg.changesDir ?? '');
          break;
        }

        case 'formPrefill' as any: {
          const { form, table, schema, sql, hint, columns } = (msg as any).payload ?? {};
          if (form === 'insert') {
            setFormSnapshot(prev => ({ ...prev, insert: { ...prev?.insert, tableName: schema ? `${schema}.${table}` : table, ...(columns ? { columns } : {}) } }));
            handleTabChange('insert');
          } else if (form === 'ddl') {
            setFormSnapshot(prev => ({ ...prev, ddl: { ...prev?.ddl, defaultSchema: schema || '', ...(table ? { tableName: table } : {}), ...(columns ? { columns } : {}), action: 'alter' } }));
            handleTabChange('ddl');
          } else if (form === 'freeform') {
            setFormSnapshot(prev => ({ ...prev, freeform: { ...prev?.freeform, ...(sql ? { sql } : {}), ...(hint ? { changeHint: hint } : {}), ...(schema ? { dbSchema: schema } : {}) } }));
            handleTabChange('freeform');
          }
          break;
        }

        case 'gitCommitDone' as any: {
          const { commitMessage, commitHash } = (msg as any).payload ?? {};
          const short = commitHash ? commitHash.slice(0, 7) : '';
          const label = commitMessage ? `Committed: ${commitMessage}${short ? ` (${short})` : ''}` : 'Changes committed to git';
          addToast(label, 'ok');
          break;
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [addToast]);

  const handleTabChange = (t: Tab) => {
    if (t === 'schema_explorer') {
      postMsg({ type: 'runCommand', command: 'dmcr.openSchemaExplorer' });
      return;
    }
    setTab(t);
    setReadyTabs(prev => { const s = new Set(prev); s.delete(t as string); return s; });
    if (t === 'settings') postMsg({ type: 'ready' });
  };

  const FORM_TABS: { tab: Tab; form: string }[] = [
    { tab: 'ddl',          form: 'ddl' },
    { tab: 'insert',       form: 'insert' },
    { tab: 'freeform',     form: 'freeform' },
    { tab: 'schema_diff',  form: 'schema_diff' },
    { tab: 'conversation', form: 'conversation' },
  ];

  const handleOpenForm = (form: string) => {
    setReadyTabs(prev => { const s = new Set(prev); s.delete(form); return s; });
    setRecentForms(prev => [form, ...prev.filter(f => f !== form)].slice(0, 5));
    if (form === 'runner') {
      setTab('runner');
      return;
    }
    if (form === 'conversation') {
      setTab('conversation');
      return;
    }
    if (form === 'schema_explorer') {
      postMsg({ type: 'runCommand', command: 'dmcr.openSchemaExplorer' });
      return;
    }
    const formTab = FORM_TABS.find(f => f.form === form);
    if (formTab) setTab(formTab.tab);
    if (['ddl','insert','freeform','schema_diff'].includes(form)) {
      activeFormTabRef.current = form as 'ddl'|'insert'|'freeform'|'schema_diff';
      postMsg({ type: 'setActiveForm', payload: { form } });
    }
  };

  /* ── "Open in New Tab" context menu ── */
  const ctxFormRef = useRef<string>('');
  const openInNewTab = useCallback(() => {
    if (ctxFormRef.current) postMsg({ type: 'openInNewTab', payload: { form: ctxFormRef.current } });
  }, []);
  const ctxMenu = useContextMenu([
    {
      label: 'Open in New Tab',
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
      onClick: openInNewTab,
    },
  ]);
  /** Right-click handler for nav tabs and home tiles */
  const handleTabContextMenu = useCallback((form: string, e: React.MouseEvent) => {
    ctxFormRef.current = form;
    ctxMenu.show(e);
  }, [ctxMenu]);

  /** Suppress default browser context menu except in inputs/textareas/contenteditable */
  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;
    e.preventDefault();
  }, []);

  /** Keyboard shortcut help popover */
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);

  /** Keyboard shortcuts: Ctrl/Cmd+H → home, +, → settings, +R → runner, +1-8 → tabs by index */
  useEffect(() => {
    const TAB_ORDER: Tab[] = ['home', 'ddl', 'insert', 'freeform', 'schema_diff', 'conversation', 'runner', 'settings'];
    const handler = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      // Don't intercept when typing in inputs
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement).isContentEditable) return;

      // Digit shortcuts: Ctrl+1..8
      const digit = parseInt(e.key, 10);
      if (!isNaN(digit) && digit >= 1 && digit <= 8) {
        const target = TAB_ORDER[digit - 1];
        if (target) { e.preventDefault(); handleTabChange(target); }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'h':
          e.preventDefault();
          handleTabChange('home');
          break;
        case ',':
          e.preventDefault();
          handleTabChange('settings');
          break;
        case 'r':
          e.preventDefault();
          handleTabChange('runner');
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleThemeToggle = () => {
    const next: AppTheme = effectiveDark ? 'light' : 'dark';
    setAppTheme(next);
    postMsg({ type: 'saveTheme', payload: { theme: next } });
  };

  return (
    <div className="bs-root" data-theme={effectiveDark ? 'dark' : 'light'} onContextMenu={handleRootContextMenu}>
      {/* -- Topbar -- */}
      <div className="bs-topbar">
        {/* Left: brand + theme toggle */}
        <div className="bs-topbar-left">
          <span className="bs-topbar-brand">
            <DmcrLogo />
            DMCR
          </span>
          <button
            className="bs-theme-toggle"
            onClick={handleThemeToggle}
            title={effectiveDark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={effectiveDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {effectiveDark ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>

        {/* Center: tabs — full names normally, icon-only when overflowing */}
        <div className="bs-topbar-center-wrap">
          <div className={`bs-topbar-center${tabsOverflow ? ' is-overflowing' : ''}`} ref={tabsScrollRef}>
            <button className={`bs-topbar-tab${tab === 'home' ? ' is-active' : ''}`} onClick={() => handleTabChange('home')} onContextMenu={e => handleTabContextMenu('home', e)} data-label="Home">
              <span className="bs-tab-icon"><HomeIcon /></span>
              <span className="bs-tab-label">Home</span>
            </button>
            <button className={`bs-topbar-tab${tab === 'ddl' ? ' is-active' : ''}`} onClick={() => handleOpenForm('ddl')} onContextMenu={e => handleTabContextMenu('ddl', e)} data-label="DDL">
              <span className="bs-tab-icon"><DDLTabIcon /></span>
              <span className="bs-tab-label">DDL</span>
              {generatingForms.has('ddl') && <span className="tab-gen-dot" />}
              {readyTabs.has('ddl') && !generatingForms.has('ddl') && <span className="tab-ready-badge" />}
            </button>
            <button className={`bs-topbar-tab${tab === 'insert' ? ' is-active' : ''}`} onClick={() => handleOpenForm('insert')} onContextMenu={e => handleTabContextMenu('insert', e)} data-label="DML">
              <span className="bs-tab-icon"><DMLTabIcon /></span>
              <span className="bs-tab-label">DML</span>
              {generatingForms.has('insert') && <span className="tab-gen-dot" />}
              {readyTabs.has('insert') && !generatingForms.has('insert') && <span className="tab-ready-badge" />}
            </button>
            <button className={`bs-topbar-tab${tab === 'freeform' ? ' is-active' : ''}`} onClick={() => handleOpenForm('freeform')} onContextMenu={e => handleTabContextMenu('freeform', e)} data-label="Freeform">
              <span className="bs-tab-icon"><FreeformTabIcon /></span>
              <span className="bs-tab-label">Freeform</span>
              {generatingForms.has('freeform') && <span className="tab-gen-dot" />}
              {readyTabs.has('freeform') && !generatingForms.has('freeform') && <span className="tab-ready-badge" />}
            </button>
            <button className={`bs-topbar-tab${tab === 'schema_diff' ? ' is-active' : ''}`} onClick={() => handleOpenForm('schema_diff')} onContextMenu={e => handleTabContextMenu('schema_diff', e)} data-label="Diff">
              <span className="bs-tab-icon"><SchemaDiffTabIcon /></span>
              <span className="bs-tab-label">Diff</span>
              {generatingForms.has('schema_diff') && <span className="tab-gen-dot" />}
              {readyTabs.has('schema_diff') && !generatingForms.has('schema_diff') && <span className="tab-ready-badge" />}
            </button>
            <button className={`bs-topbar-tab${tab === 'conversation' ? ' is-active' : ''}`} onClick={() => handleTabChange('conversation')} onContextMenu={e => handleTabContextMenu('conversation', e)} data-label="Assistant">
              <span className="bs-tab-icon"><AssistantTabIcon /></span>
              <span className="bs-tab-label">Assistant</span>
              {chatBusy && <span className="tab-gen-dot" />}
              {readyTabs.has('conversation') && !chatBusy && <span className="tab-ready-badge" />}
            </button>
            <button className={`bs-topbar-tab${tab === 'runner' ? ' is-active' : ''}`} onClick={() => setTab('runner')} onContextMenu={e => handleTabContextMenu('runner', e)} data-label="Runner">
              <span className="bs-tab-icon"><RunnerTabIcon /></span>
              <span className="bs-tab-label">Runner</span>
            </button>
            <button className={`bs-topbar-tab${tab === 'settings' ? ' is-active' : ''}`} onClick={() => handleTabChange('settings')} onContextMenu={e => handleTabContextMenu('settings', e)} data-label="Settings">
              <span className="bs-tab-icon"><SettingsIcon /></span>
              <span className="bs-tab-label">Settings</span>
            </button>
          </div>
        </div>

        {/* Right: active provider pill + keyboard shortcut help */}
        <div className="bs-topbar-right" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
          {snapshot && (() => {
            const cp = snapshot.customProviders.find(p => p.key === snapshot.activeProvider);
            const providerLabel = cp?.name ?? PROVIDER_LABELS[snapshot.activeProvider] ?? snapshot.activeProvider;
            return <ProviderPill label={providerLabel} model={snapshot.activeFamily} onClick={() => { setSettingsSection('llm'); handleTabChange('settings'); }} />;
          })()}
          <button
            onClick={() => setShowShortcutHelp(v => !v)}
            title="Keyboard shortcuts"
            style={{
              width: 20, height: 20, borderRadius: '50%', border: '1px solid rgba(99,102,241,0.3)',
              background: showShortcutHelp ? 'rgba(99,102,241,0.2)' : 'rgba(99,102,241,0.08)',
              color: '#a5b4fc', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, transition: 'all 120ms', lineHeight: 1,
            }}
          >?</button>
          {showShortcutHelp && (
            <div
              style={{
                position: 'absolute', top: 28, right: 0, zIndex: 999,
                background: 'var(--bs-surface, #0f172a)', border: '1px solid rgba(99,102,241,0.3)',
                borderRadius: 10, padding: '12px 16px', minWidth: 260,
                boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
                fontSize: 12,
              }}
              onMouseLeave={() => setShowShortcutHelp(false)}
            >
              <div style={{ fontWeight: 700, color: '#a5b4fc', marginBottom: 10, fontSize: 11.5, letterSpacing: 0.4 }}>Keyboard Shortcuts</div>
              {([
                ['Ctrl/Cmd + H', 'Home'],
                ['Ctrl/Cmd + ,', 'Settings'],
                ['Ctrl/Cmd + R', 'Runner'],
                ['Ctrl/Cmd + 1', 'Home'],
                ['Ctrl/Cmd + 2', 'DDL'],
                ['Ctrl/Cmd + 3', 'DML'],
                ['Ctrl/Cmd + 4', 'Freeform'],
                ['Ctrl/Cmd + 5', 'Schema Diff'],
                ['Ctrl/Cmd + 6', 'Assistant'],
                ['Ctrl/Cmd + 7', 'Runner'],
                ['Ctrl/Cmd + 8', 'Settings'],
              ] as [string, string][]).map(([key, label]) => (
                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 5 }}>
                  <code style={{ fontSize: 10.5, color: '#818cf8', background: 'rgba(99,102,241,0.12)', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>{key}</code>
                  <span style={{ color: 'var(--text-secondary, #94a3b8)', whiteSpace: 'nowrap' }}>{label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* -- Page content -- */}
      <div style={{ minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: 1 }}>
        {tab === 'home' && (
          <HomePage
            genState={genState}
            onOpenForm={handleOpenForm}
            onContextMenu={handleTabContextMenu}
            sqliteStatus={snapshot?.sqliteStatus ?? 'ok'}
            sqliteError={snapshot?.sqliteError}
            hasDbMcp={hasDbMcp}
            generatingForms={generatingForms}
            recentForms={recentForms}
            workspaceReady={changesDir === null ? undefined : !!changesDir}
          />
        )}
        {/* DDL / DML / Freeform / Schema Diff — always mounted so in-progress generation survives tab switches */}
        <div style={{ display: tab === 'ddl' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' }}>
          <DdlPage key={`ddl-${formResetKeys.ddl}`} visible={tab === 'ddl'} form="ddl" availableSchemas={availableSchemas} existingChanges={existingChanges} initialState={formSnapshot.ddl} onStateChange={p => handleFormStateChange('ddl', p)} />
        </div>
        <div style={{ display: tab === 'insert' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' }}>
          <InsertPage key={`insert-${formResetKeys.insert}`} visible={tab === 'insert'} form="insert" availableSchemas={availableSchemas} existingChanges={existingChanges} initialState={formSnapshot.insert} onStateChange={p => handleFormStateChange('insert', p)} />
        </div>
        <div style={{ display: tab === 'freeform' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' }}>
          <FreeformPage key={`freeform-${formResetKeys.freeform}`} visible={tab === 'freeform'} form="freeform" availableSchemas={availableSchemas} existingChanges={existingChanges} initialState={formSnapshot.freeform} onStateChange={p => handleFormStateChange('freeform', p)} />
        </div>
        <div style={{ display: tab === 'schema_diff' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' }}>
          <SchemaDiffPage key={`schema_diff-${formResetKeys.schema_diff}`} visible={tab === 'schema_diff'} form="schema_diff" availableSchemas={availableSchemas} existingChanges={existingChanges} />
        </div>
        {/* Conversation tab — always mounted so bridge state persists */}
        <div style={{ display: tab === 'conversation' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <ConversationPage isDark={effectiveDark} availableSchemas={availableSchemas} initialState={formSnapshot.conversation} onStateChange={p => handleFormStateChange('conversation', p)} />
        </div>
        {/* Runner tab — always mounted so xterm persists between tab switches */}
        <div style={{ display: tab === 'runner' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <RunnerPage onReady={(handle) => { runnerRef.current = handle; }} isDark={effectiveDark} />
        </div>
        {tab === 'settings' && (
          <SettingsPage
            snapshot={snapshot}
            onSnapshotChange={setSnapshot}
            addToast={addToast}
            dbInfo={dbInfo}
            systemInfo={systemInfo}
            aiFootprint={aiFootprint}
            initialSection={settingsSection as any}
            onSectionChange={(s) => setSettingsSection(s)}
            initialDevTool={devToolActive}
            onDevToolChange={setDevToolActive}
            theme={appTheme}
            onThemeChange={(t) => { setAppTheme(t); postMsg({ type: 'saveTheme', payload: { theme: t } }); }}
          />
        )}
      </div>

      {/* -- Corner widget: reload + close (form tabs only) -- */}
      {(tab === 'ddl' || tab === 'insert' || tab === 'freeform') && (
        <div className="bs-corner-widget">
          <button
            className="bs-corner-btn bs-corner-reload"
            title="Reload form"
            onClick={() => {
              postMsg({ type: 'setActiveForm', payload: { form: tab } });
              // formActivated will be echoed back → resets form screen to 'form'
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>
            </svg>
          </button>
          <button
            className="bs-corner-btn bs-corner-close"
            title="Close form"
            onClick={() => { postMsg({ type: 'cancel', payload: { form: tab, goHome: true } }); }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>
            </svg>
          </button>
        </div>
      )}

      {/* -- Toasts -- */}
      <div className="bs-toast-container">
        {toasts.map(t => <Toast key={t.id} data={t} />)}
      </div>

      {/* -- Context menu portal -- */}
      {ctxMenu.menu}
    </div>
  );
}

/* --- Inline mini components ------------------------------- */

const PROVIDER_LABELS: Record<string, string> = {
  copilot: 'GitHub Copilot', openai: 'OpenAI', anthropic: 'Anthropic',
  lmstudio: 'LM Studio', ollama: 'Ollama',
};

function RunnerTabIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function QuickStartIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function ProviderPill({ label, model, onClick }: { label: string; model?: string; onClick?: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick?.(); }}
      style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 500,
      padding: '2px 7px', borderRadius: 20,
      background: 'rgba(99,102,241,0.10)', color: '#a5b4fc',
      border: '1px solid rgba(99,102,241,0.22)',
      maxWidth: 200, overflow: 'hidden',
      cursor: 'pointer', transition: 'background 150ms, border-color 150ms',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22c55e', flexShrink: 0, display: 'inline-block' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {model && (
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: '#818cf8', fontSize: 9.5, fontWeight: 400,
          borderLeft: '1px solid rgba(99,102,241,0.3)', paddingLeft: 5, marginLeft: 1,
        }}>{model}</span>
      )}
    </span>
  );
}

function DmcrLogo() {
  return (
    <svg className="bs-topbar-brand-icon" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="6" fill="#6366f1" opacity=".15" />
      <path d="M7 17V7h4a5 5 0 0 1 0 10H7z" fill="none" stroke="#6366f1" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="16" cy="10" r="1.5" fill="#6366f1" />
      <circle cx="16" cy="14" r="1.5" fill="#22c55e" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function DDLTabIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function DMLTabIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function FreeformTabIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function SchemaDiffTabIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/>
      <line x1="11" y1="7" x2="13" y2="7"/><line x1="11" y1="12" x2="13" y2="12"/><line x1="11" y1="17" x2="13" y2="17"/>
    </svg>
  );
}

function AssistantTabIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="2" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="bs-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

const FORM_META: Record<string, { label: string; color: string; desc: string }> = {
  ddl:          { label: 'DDL Form',        color: '#60a5fa', desc: 'Schema Builder — ALTER TABLE, CREATE TABLE, sequences and role grants' },
  insert:       { label: 'DML Form',        color: '#34d399', desc: 'Insert Rows — seed data with idempotent ON CONFLICT handling' },
  freeform:     { label: 'Freeform SQL',    color: '#818cf8', desc: 'Any SQL — AI generates deploy / verify / revert' },
  schema_diff:  { label: 'Schema Diff',     color: '#a78bfa', desc: 'Compare two schemas and generate change SQL for every structural difference' },
  conversation: { label: 'DMCR Assistant',  color: '#f472b6', desc: 'Conversational DMCR — chat to build changes end-to-end' },
};

