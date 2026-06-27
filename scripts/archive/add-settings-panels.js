// Patch SettingsPage.tsx:
// 1. Add dbInfo + systemInfo props to SettingsPage
// 2. Add 'db' and 'memory' to SECTION_TABS
// 3. Add DbPanel and MemoryPanel components
// 4. Route new sections in render
const fs = require('fs');
const f = 'webview-ui/src/pages/SettingsPage.tsx';
let t = fs.readFileSync(f, 'utf8');

// ── 1. Update Props interface to include dbInfo + systemInfo ─────────────────
t = t.replace(
  `interface Props {
  snapshot: SettingsSnapshot | null;
  onSnapshotChange: (s: SettingsSnapshot) => void;
  addToast: (msg: string, type?: ToastData['type']) => void;
}`,
  `import type { DbInfoPayload, SystemInfoPayload } from '../types';

interface Props {
  snapshot: SettingsSnapshot | null;
  onSnapshotChange: (s: SettingsSnapshot) => void;
  addToast: (msg: string, type?: ToastData['type']) => void;
  dbInfo?: DbInfoPayload | null;
  systemInfo?: SystemInfoPayload | null;
}`
);

// ── 2. Update SECTION_TABS to add DB and Memory tabs ─────────────────────────
t = t.replace(
  `type Section = 'llm' | 'custom';

const SECTION_TABS: { id: Section; label: string; Icon: React.FC<React.SVGProps<SVGSVGElement>> }[] = [
  { id: 'llm',    label: 'LLM Provider Configuration', Icon: LlmIcon },
  { id: 'custom', label: 'Custom Providers',            Icon: PlugIcon },
];`,
  `type Section = 'llm' | 'custom' | 'db' | 'memory';

const SECTION_TABS: { id: Section; label: string; Icon: React.FC<React.SVGProps<SVGSVGElement>> }[] = [
  { id: 'llm',    label: 'LLM Provider Configuration', Icon: LlmIcon },
  { id: 'custom', label: 'Custom Providers',            Icon: PlugIcon },
  { id: 'db',     label: 'DB Config',                  Icon: DbIcon },
  { id: 'memory', label: 'Memory Footprint',            Icon: ChipIcon },
];`
);

// ── 3. Update SettingsPage function signature + routing ───────────────────────
t = t.replace(
  `export default function SettingsPage({ snapshot, onSnapshotChange, addToast }: Props) {`,
  `export default function SettingsPage({ snapshot, onSnapshotChange, addToast, dbInfo, systemInfo }: Props) {`
);

// ── 4. Add DB and Memory section routing in content div ──────────────────────
t = t.replace(
  `        {section === 'llm'    && <LlmPanel    snapshot={snapshot} onSnapshotChange={onSnapshotChange} addToast={addToast} />}
        {section === 'custom' && <CustomPanel snapshot={snapshot} onSnapshotChange={onSnapshotChange} addToast={addToast} />}`,
  `        {section === 'llm'    && <LlmPanel    snapshot={snapshot} onSnapshotChange={onSnapshotChange} addToast={addToast} />}
        {section === 'custom' && <CustomPanel snapshot={snapshot} onSnapshotChange={onSnapshotChange} addToast={addToast} />}
        {section === 'db'     && <DbPanel     dbInfo={dbInfo} />}
        {section === 'memory' && <MemoryPanel systemInfo={systemInfo} />}`
);

// ── 5. Append DbPanel, MemoryPanel, and new icons before the final export ────
const DB_AND_MEMORY_PANELS = `
/* ============================================================
 * DbIcon / ChipIcon (new icons for sidebar)
 * ============================================================ */
function DbIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
    </svg>
  );
}

function ChipIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1" />
      <path d="M16 2v3M8 2v3M16 19v3M8 19v3M22 16h-3M22 8h-3M2 16h3M2 8h3" />
    </svg>
  );
}

/* ============================================================
 * DB Config Panel
 * ============================================================ */
interface DbPanelProps { dbInfo?: DbInfoPayload | null; }

function DbPanel({ dbInfo }: DbPanelProps) {
  const [loading, setLoading] = useState(!dbInfo);

  useEffect(() => {
    postMsg({ type: 'getDbInfo' });
    setLoading(true);
  }, []);

  useEffect(() => {
    if (dbInfo) setLoading(false);
  }, [dbInfo]);

  function fmtBytes(b: number) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }

  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <DbIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3">DB Config</h3>
      </div>

      {loading && !dbInfo && (
        <div style={{ color: '#64748b', fontSize: 12, padding: '20px 0' }}>Loading database info...</div>
      )}

      {dbInfo && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* SQLite version + DB size */}
          <div className="bs-info-grid">
            <div className="bs-info-card">
              <div className="bs-info-card-label">SQLite Version</div>
              <div className="bs-info-card-value bs-mono">{dbInfo.sqliteVersion}</div>
            </div>
            <div className="bs-info-card">
              <div className="bs-info-card-label">Database Size</div>
              <div className="bs-info-card-value">{fmtBytes(dbInfo.dbSizeBytes)}</div>
            </div>
            <div className="bs-info-card">
              <div className="bs-info-card-label">Tables</div>
              <div className="bs-info-card-value">{dbInfo.tables.length}</div>
            </div>
          </div>

          {/* Paths */}
          <div>
            <div className="bs-info-section-title">Paths</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="bs-path-row">
                <span className="bs-path-label">Database File</span>
                <span className="bs-path-value bs-mono">{dbInfo.dbPath}</span>
              </div>
              <div className="bs-path-row">
                <span className="bs-path-label">Extension Root</span>
                <span className="bs-path-value bs-mono">{dbInfo.extensionPath}</span>
              </div>
            </div>
          </div>

          {/* Tables */}
          {dbInfo.tables.length > 0 && (
            <div>
              <div className="bs-info-section-title">Tables</div>
              <div className="bs-table-list">
                {dbInfo.tables.map(tbl => (
                  <div key={tbl.name} className="bs-table-row">
                    <span className="bs-table-name bs-mono">{tbl.name}</span>
                    <span className="bs-table-count">{tbl.count.toLocaleString()} row{tbl.count !== 1 ? 's' : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Refresh */}
          <div>
            <button
              className="bs-btn-sm bs-btn-secondary"
              onClick={() => { setLoading(true); postMsg({ type: 'getDbInfo' }); }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.27" />
              </svg>
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * Memory Footprint Panel
 * ============================================================ */
interface MemoryPanelProps { systemInfo?: SystemInfoPayload | null; }

function MemoryPanel({ systemInfo }: MemoryPanelProps) {
  const [loading, setLoading] = useState(!systemInfo);

  useEffect(() => {
    postMsg({ type: 'getSystemInfo' });
    setLoading(true);
  }, []);

  useEffect(() => {
    if (systemInfo) setLoading(false);
  }, [systemInfo]);

  function fmtBytes(b: number) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
    return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }
  function fmtSec(s: number) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return [d && (d + 'd'), h && (h + 'h'), m + 'm'].filter(Boolean).join(' ') || '<1m';
  }
  function pct(used: number, total: number) {
    return total ? ((used / total) * 100).toFixed(1) + '%' : '—';
  }

  if (loading && !systemInfo) {
    return (
      <div className="bs-settings-pane">
        <div className="bs-settings-section-head"><ChipIcon className="bs-ico-sm" /><h3 className="bs-settings-h3">Memory Footprint</h3></div>
        <div style={{ color: '#64748b', fontSize: 12, padding: '20px 0' }}>Loading system info...</div>
      </div>
    );
  }
  if (!systemInfo) return null;

  const heapPct = parseFloat(pct(systemInfo.heapUsed, systemInfo.heapTotal));
  const osMemPct = parseFloat(pct(systemInfo.totalMemBytes - systemInfo.freeMemBytes, systemInfo.totalMemBytes));

  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <ChipIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3">Memory Footprint</h3>
        <button className="bs-btn-sm bs-btn-secondary" style={{ marginLeft: 'auto' }}
          onClick={() => { setLoading(true); postMsg({ type: 'getSystemInfo' }); }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.27" />
          </svg>
          Refresh
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

        {/* Extension Process Memory */}
        <section>
          <div className="bs-info-section-title">Extension Process Memory</div>
          <div className="bs-info-grid bs-info-grid--4">
            {[
              { label: 'Heap Used',       val: fmtBytes(systemInfo.heapUsed),     sub: pct(systemInfo.heapUsed, systemInfo.heapTotal), accent: heapPct > 80 },
              { label: 'Heap Total',      val: fmtBytes(systemInfo.heapTotal),    sub: 'allocated' },
              { label: 'RSS',             val: fmtBytes(systemInfo.rss),          sub: 'resident set' },
              { label: 'External',        val: fmtBytes(systemInfo.external),     sub: 'native memory' },
              { label: 'Array Buffers',   val: fmtBytes(systemInfo.arrayBuffers), sub: 'off-heap' },
            ].map(item => (
              <div key={item.label} className={\`bs-info-card\${item.accent ? ' bs-info-card--warn' : ''}\`}>
                <div className="bs-info-card-label">{item.label}</div>
                <div className="bs-info-card-value">{item.val}</div>
                {item.sub && <div className="bs-info-card-sub">{item.sub}</div>}
              </div>
            ))}
          </div>
          {/* Heap usage bar */}
          <div className="bs-progress-row" style={{ marginTop: 10 }}>
            <span className="bs-progress-label">Heap</span>
            <div className="bs-progress-bar">
              <div className="bs-progress-fill" style={{
                width: pct(systemInfo.heapUsed, systemInfo.heapTotal),
                background: heapPct > 80 ? '#f87171' : heapPct > 60 ? '#fbbf24' : '#6366f1',
              }} />
            </div>
            <span className="bs-progress-pct">{pct(systemInfo.heapUsed, systemInfo.heapTotal)}</span>
          </div>
        </section>

        {/* OS Memory */}
        <section>
          <div className="bs-info-section-title">System Memory</div>
          <div className="bs-info-grid">
            <div className="bs-info-card">
              <div className="bs-info-card-label">Total RAM</div>
              <div className="bs-info-card-value">{fmtBytes(systemInfo.totalMemBytes)}</div>
            </div>
            <div className="bs-info-card">
              <div className="bs-info-card-label">Free RAM</div>
              <div className="bs-info-card-value">{fmtBytes(systemInfo.freeMemBytes)}</div>
            </div>
            <div className="bs-info-card">
              <div className="bs-info-card-label">Used RAM</div>
              <div className="bs-info-card-value">{fmtBytes(systemInfo.totalMemBytes - systemInfo.freeMemBytes)}</div>
              <div className="bs-info-card-sub">{pct(systemInfo.totalMemBytes - systemInfo.freeMemBytes, systemInfo.totalMemBytes)} of total</div>
            </div>
          </div>
          <div className="bs-progress-row" style={{ marginTop: 10 }}>
            <span className="bs-progress-label">RAM</span>
            <div className="bs-progress-bar">
              <div className="bs-progress-fill" style={{
                width: pct(systemInfo.totalMemBytes - systemInfo.freeMemBytes, systemInfo.totalMemBytes),
                background: osMemPct > 85 ? '#f87171' : osMemPct > 70 ? '#fbbf24' : '#22c55e',
              }} />
            </div>
            <span className="bs-progress-pct">{pct(systemInfo.totalMemBytes - systemInfo.freeMemBytes, systemInfo.totalMemBytes)}</span>
          </div>
        </section>

        {/* CPU */}
        <section>
          <div className="bs-info-section-title">CPU</div>
          <div className="bs-info-grid">
            <div className="bs-info-card" style={{ gridColumn: '1 / -1' }}>
              <div className="bs-info-card-label">Model</div>
              <div className="bs-info-card-value" style={{ fontSize: 12 }}>{systemInfo.cpuModel}</div>
            </div>
            <div className="bs-info-card">
              <div className="bs-info-card-label">Cores</div>
              <div className="bs-info-card-value">{systemInfo.cpuCount}</div>
            </div>
            <div className="bs-info-card">
              <div className="bs-info-card-label">Speed</div>
              <div className="bs-info-card-value">{systemInfo.cpuSpeed} MHz</div>
            </div>
            <div className="bs-info-card">
              <div className="bs-info-card-label">System Uptime</div>
              <div className="bs-info-card-value">{fmtSec(systemInfo.uptime)}</div>
            </div>
          </div>
        </section>

        {/* VS Code + Runtime */}
        <section>
          <div className="bs-info-section-title">VS Code & Runtime</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { k: 'VS Code',     v: systemInfo.vscodeVersion },
              { k: 'App Name',    v: systemInfo.appName },
              { k: 'App Host',    v: systemInfo.appHost },
              { k: 'Remote',      v: systemInfo.remoteName },
              { k: 'Language',    v: systemInfo.language },
              { k: 'Shell',       v: systemInfo.shell },
              { k: 'Electron',    v: systemInfo.versions.electron },
              { k: 'Node.js',     v: systemInfo.versions.node },
              { k: 'V8',          v: systemInfo.versions.v8 },
              { k: 'OpenSSL',     v: systemInfo.versions.openssl },
            ].map(row => (
              <div key={row.k} className="bs-kv-row">
                <span className="bs-kv-key">{row.k}</span>
                <span className="bs-kv-val bs-mono">{row.v}</span>
              </div>
            ))}
          </div>
        </section>

        {/* OS */}
        <section>
          <div className="bs-info-section-title">Operating System</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { k: 'Platform',   v: systemInfo.platform },
              { k: 'OS Release', v: systemInfo.release },
              { k: 'Arch',       v: systemInfo.arch },
              { k: 'Hostname',   v: systemInfo.hostname },
            ].map(row => (
              <div key={row.k} className="bs-kv-row">
                <span className="bs-kv-key">{row.k}</span>
                <span className="bs-kv-val bs-mono">{row.v}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Paths */}
        <section>
          <div className="bs-info-section-title">Paths</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'Extension Root', val: systemInfo.extensionPath },
              { label: 'Home Dir',       val: systemInfo.homeDir },
              { label: 'Temp Dir',       val: systemInfo.tmpDir },
            ].map(row => (
              <div key={row.label} className="bs-path-row">
                <span className="bs-path-label">{row.label}</span>
                <span className="bs-path-value bs-mono">{row.val}</span>
              </div>
            ))}
          </div>
        </section>

      </div>
    </div>
  );
}
`;

// Insert before the LLM Panel section (which starts right after the closing of SettingsPage function)
const INSERT_BEFORE = `/* ============================================================
 * LLM Panel -- ditto ck8t LlmConfigPanel`;
t = t.replace(INSERT_BEFORE, DB_AND_MEMORY_PANELS + INSERT_BEFORE);

fs.writeFileSync(f, t, 'utf8');
console.log('SettingsPage.tsx patched. Lines:', t.split('\n').length);
console.log('DbPanel:', t.includes('function DbPanel'));
console.log('MemoryPanel:', t.includes('function MemoryPanel'));
console.log('DbIcon:', t.includes('function DbIcon'));
console.log('ChipIcon:', t.includes('function ChipIcon'));
console.log('db tab:', t.includes("id: 'db'"));
console.log('memory tab:', t.includes("id: 'memory'"));
