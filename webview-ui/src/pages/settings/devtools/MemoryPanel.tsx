import React, { useState, useEffect } from 'react';
import { postMsg } from '../../../vscode';
import type { SystemInfoPayload } from '../../../types';
import { ChipIcon } from '../icons';
import { ProcessListSection } from './ProcessListSection';

/* ============================================================
 * Memory Footprint Panel
 * ============================================================ */
interface MemoryPanelProps { systemInfo?: SystemInfoPayload | null; headless?: boolean; }

export function MemoryPanel({ systemInfo, headless }: MemoryPanelProps) {
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
        {!headless && <div className="bs-settings-section-head"><ChipIcon className="bs-ico-sm" /><h3 className="bs-settings-h3">Memory Footprint</h3></div>}
        <div style={{ color: '#64748b', fontSize: 12, padding: '20px 0' }}>Loading system info...</div>
      </div>
    );
  }
  if (!systemInfo) return null;

  const heapPct = parseFloat(pct(systemInfo.heapUsed, systemInfo.heapTotal));
  const osMemPct = parseFloat(pct(systemInfo.totalMemBytes - systemInfo.freeMemBytes, systemInfo.totalMemBytes));

  return (
    <div className="bs-settings-pane">
      {!headless && (
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
      )}

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
              <div key={item.label} className={`bs-info-card${item.accent ? ' bs-info-card--warn' : ''}`}>
                <div className="bs-info-card-label">{item.label}</div>
                <div className="bs-info-card-value">{item.val}</div>
                {item.sub && <div className="bs-info-card-sub">{item.sub}</div>}
              </div>
            ))}
          </div>
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

        {/* Process List */}
        {systemInfo.processList && systemInfo.processList.length > 0 && (
          <ProcessListSection processList={systemInfo.processList} totalMem={systemInfo.totalMemBytes} fmtBytes={fmtBytes} />
        )}

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
