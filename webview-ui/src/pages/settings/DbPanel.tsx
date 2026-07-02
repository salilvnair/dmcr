import React, { useState, useEffect } from 'react';
import { postMsg } from '../../vscode';
import { DbIcon } from './icons';
import type { DbInfoPayload } from '../../types';

interface DbPanelProps { dbInfo?: DbInfoPayload | null; }

export function DbPanel({ dbInfo }: DbPanelProps) {
  const [loading, setLoading] = useState(!dbInfo);
  const [refreshing, setRefreshing] = useState(false);
  const [footprintLimit, setFootprintLimit] = useState<string>('10000');
  const [displayLimit, setDisplayLimit] = useState<string>('500');
  const [limitSaved, setLimitSaved] = useState(false);
  const [displayLimitSaved, setDisplayLimitSaved] = useState(false);

  useEffect(() => {
    postMsg({ type: 'getDbInfo' });
    postMsg({ type: 'getAiFootprintSettings' });
    setLoading(true);
  }, []);

  useEffect(() => {
    const handler = (evt: MessageEvent) => {
      const msg = evt.data;
      if (msg?.type === 'aiFootprintSettings') {
        const { keepLimit, showLimit } = msg.payload as { keepLimit: number; showLimit: number };
        if (keepLimit) setFootprintLimit(String(keepLimit));
        if (showLimit) setDisplayLimit(String(showLimit));
      }
      if (msg?.type === 'aiFootprintLimitSaved') {
        const { keepLimit, showLimit } = msg.payload as { keepLimit?: number; showLimit?: number };
        if (keepLimit) setFootprintLimit(String(keepLimit));
        if (showLimit) setDisplayLimit(String(showLimit));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (dbInfo) { setLoading(false); setRefreshing(false); }
  }, [dbInfo]);

  const handleRefresh = () => {
    setRefreshing(true);
    setLoading(true);
    postMsg({ type: 'getDbInfo' });
  };

  function fmtBytes(b: number) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }

  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DbIcon className="bs-ico-sm" />
          <h3 className="bs-settings-h3" style={{ margin: 0 }}>DB Config</h3>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh database info"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 10px', fontSize: 11.5, fontWeight: 600,
            borderRadius: 6, border: '1px solid var(--bs-border, rgba(99,102,241,0.25))',
            background: 'transparent', color: 'var(--text-secondary, #64748b)',
            cursor: refreshing ? 'not-allowed' : 'pointer',
            opacity: refreshing ? 0.6 : 1,
            transition: 'all 120ms',
          }}
          onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.color = '#818cf8'; e.currentTarget.style.borderColor = '#6366f1'; } }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary, #64748b)'; e.currentTarget.style.borderColor = 'var(--bs-border, rgba(99,102,241,0.25))'; }}
        >
          <svg
            width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }}
          >
            <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.27" />
          </svg>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading && !dbInfo && (
        <div style={{ color: 'var(--text-secondary, #64748b)', fontSize: 12, padding: '20px 0' }}>Loading database info...</div>
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

          {/* AI Footprint limit settings */}
          <div>
            <div className="bs-info-section-title">AI Footprint</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)', whiteSpace: 'nowrap', minWidth: 180 }}>Max audit records to keep</label>
                <input
                  className="bs-input"
                  type="number"
                  min={1}
                  max={100000}
                  value={footprintLimit}
                  onChange={e => setFootprintLimit(e.target.value)}
                  style={{ width: 90, height: 30 }}
                />
                <button
                  className="bs-btn-sm bs-btn-primary"
                  onClick={() => {
                    const n = parseInt(footprintLimit, 10);
                    if (!isNaN(n) && n >= 1) {
                      postMsg({ type: 'saveAiFootprintLimit', payload: { limit: n } });
                      setLimitSaved(true);
                      setTimeout(() => setLimitSaved(false), 1500);
                    }
                  }}
                >
                  {limitSaved ? 'Saved!' : 'Save'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)', whiteSpace: 'nowrap', minWidth: 180 }}>Max audit records to show</label>
                <input
                  className="bs-input"
                  type="number"
                  min={1}
                  max={100000}
                  value={displayLimit}
                  onChange={e => setDisplayLimit(e.target.value)}
                  style={{ width: 90, height: 30 }}
                />
                <button
                  className="bs-btn-sm bs-btn-primary"
                  onClick={() => {
                    const n = parseInt(displayLimit, 10);
                    if (!isNaN(n) && n >= 1) {
                      postMsg({ type: 'saveAiFootprintDisplayLimit', payload: { limit: n } });
                      setDisplayLimitSaved(true);
                      setTimeout(() => setDisplayLimitSaved(false), 1500);
                    }
                  }}
                >
                  {displayLimitSaved ? 'Saved!' : 'Save'}
                </button>
              </div>
            </div>
          </div>

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
