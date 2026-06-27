import React, { useState, useEffect, useRef, useCallback } from 'react';
import { postMsg } from '../../../vscode';
import type { DbExplorerTableInfo } from '../../../types';
import { BackBtn } from './BackBtn';
import JsonView from '../../../components/JsonView';
import '../../DbExplorer.css';

/* ── Table → color mapping for sidebar icons ── */
const TABLE_COLORS: Record<string, string> = {
  kv: '#6366f1',
  ce_audit: '#f59e0b',
  runner_event_log: '#22c55e',
};
function tableColor(name: string): string {
  return TABLE_COLORS[name] || '#8b5cf6';
}

/* ── SVG icons per table ── */
function TableIcon({ table }: { table: string }) {
  switch (table) {
    case 'kv':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" /></svg>;
    case 'ce_audit':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>;
    case 'runner_event_log':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>;
    default:
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>;
  }
}

export function DbExplorerPanel({ onBack }: { onBack: () => void }) {
  const [tables, setTables] = useState<DbExplorerTableInfo[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Set<number | string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [collapsed, setCollapsed] = useState(false);
  const [viewRow, setViewRow] = useState<Record<string, unknown> | null>(null);
  const [rowTab, setRowTab] = useState<string>('__row__');
  const tabBarRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const startXRef = useRef(0);
  const startWRef = useRef(0);

  useEffect(() => {
    postMsg({ type: 'getDbExplorerTables' });

    function onMessage(ev: MessageEvent) {
      const msg = ev.data;
      if (msg.type === 'dbExplorerTables') {
        setTables(msg.payload.tables);
      } else if (msg.type === 'dbExplorerRows') {
        setRows(msg.payload.rows);
        setSelected(new Set());
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  function selectTable(name: string) {
    setActiveTable(name);
    setSelected(new Set());
    postMsg({ type: 'getDbExplorerRows', payload: { table: name, limit: 100, offset: 0 } });
  }

  function handleRefresh() {
    setRefreshing(true);
    postMsg({ type: 'getDbExplorerTables' });
    if (activeTable) postMsg({ type: 'getDbExplorerRows', payload: { table: activeTable, limit: 100, offset: 0 } });
    setTimeout(() => setRefreshing(false), 800);
  }

  function handleDelete() {
    if (!activeTable || selected.size === 0) return;
    const pkCol = tables.find(t => t.name === activeTable)?.pkColumn ?? null;
    postMsg({ type: 'deleteDbExplorerRows', payload: { table: activeTable, rowids: Array.from(selected), pkColumn: pkCol } });
    setSelected(new Set());
    setDeleteConfirm(false);
  }

  // Splitter drag handlers
  function onSplitterPointerDown(e: React.PointerEvent) {
    dragRef.current = true;
    startXRef.current = e.clientX;
    startWRef.current = sidebarWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onSplitterPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dx = e.clientX - startXRef.current;
    setSidebarWidth(Math.max(160, Math.min(400, startWRef.current + dx)));
    setCollapsed(false);
  }
  function onSplitterPointerUp(e: React.PointerEvent) {
    if (!dragRef.current) { setCollapsed(c => !c); }
    dragRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }

  const activeTableInfo = tables.find(t => t.name === activeTable);
  const pkColumn = activeTableInfo?.pkColumn ?? null;
  const columns = activeTableInfo ? activeTableInfo.columns : [];
  const columnTypes = activeTableInfo?.columnTypes ?? {};

  function handleExportCsv() {
    if (!activeTable || rows.length === 0) return;
    const header = columns.join(',');
    const body = rows.map(row =>
      columns.map(col => {
        const v = row[col];
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? '"' + s.replace(/"/g, '""') + '"'
          : s;
      }).join(',')
    ).join('\n');
    const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${activeTable}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // Get row's PK value for selection
  function getRowPk(row: Record<string, unknown>): number | string | null {
    if (pkColumn && row[pkColumn] != null) {
      const v = row[pkColumn];
      if (typeof v === 'number' || typeof v === 'string') return v;
      return String(v);
    }
    // Fallback: try rowid
    if (typeof row['rowid'] === 'number') return row['rowid'];
    return null;
  }

  // ── Tab scroll helpers for row detail ──
  const rowDetailTabs = viewRow ? ['Row', ...columns] : [];
  const rowDetailTabIds = viewRow ? ['__row__', ...columns] : [];
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [canScrollTabsLeft, setCanScrollTabsLeft] = useState(false);
  const [canScrollTabsRight, setCanScrollTabsRight] = useState(false);

  const updateTabOverflow = useCallback(() => {
    const el = tabBarRef.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 4;
    setTabsOverflow(overflow);
    setCanScrollTabsLeft(el.scrollLeft > 4);
    setCanScrollTabsRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = tabBarRef.current;
    if (!el || !viewRow) return;
    updateTabOverflow();
    const ro = new ResizeObserver(updateTabOverflow);
    ro.observe(el);
    el.addEventListener('scroll', updateTabOverflow);
    return () => { ro.disconnect(); el.removeEventListener('scroll', updateTabOverflow); };
  }, [viewRow, updateTabOverflow]);

  const scrollTabsLeft = useCallback(() => {
    tabBarRef.current?.scrollBy({ left: -150, behavior: 'smooth' });
  }, []);
  const scrollTabsRight = useCallback(() => {
    tabBarRef.current?.scrollBy({ left: 150, behavior: 'smooth' });
  }, []);

  function isJsonString(val: unknown): boolean {
    if (typeof val !== 'string') return false;
    const trimmed = val.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
    try { JSON.parse(trimmed); return true; } catch { return false; }
  }

  function renderCellContent(val: unknown) {
    if (val == null) return <span style={{ color: 'var(--dt-json-null, #ef4444)', fontStyle: 'italic' }}>NULL</span>;
    if (isJsonString(val)) return <JsonView value={val} defaultExpanded={3} style={{ fontSize: 12 }} />;
    const str = String(val);
    // Simple syntax coloring for non-JSON values
    if (typeof val === 'number') return <span style={{ color: 'var(--dt-json-num, #f59e0b)', fontFamily: 'monospace', fontSize: 12 }}>{str}</span>;
    if (typeof val === 'boolean') return <span style={{ color: 'var(--dt-json-bool, #3b82f6)', fontFamily: 'monospace', fontSize: 12 }}>{str}</span>;
    return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.6, color: 'var(--dt-json-str, #22c55e)' }}>{str}</pre>;
  }

  // ── Row detail view ──
  if (viewRow) {
    return (
      <div className="db-explorer" style={{ flexDirection: 'column' }}>
        {/* Header */}
        <div className="db-explorer-row-detail-head">
          <BackBtn onClick={() => { setViewRow(null); setRowTab('__row__'); }} />
          <span style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="db-explorer-table-icon" style={{ background: tableColor(activeTable!) + '22', color: tableColor(activeTable!), border: `1px solid ${tableColor(activeTable!)}55`, width: 22, height: 22 }}>
              <TableIcon table={activeTable!} />
            </span>
            {activeTable}
            <span style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)', fontWeight: 400 }}>
              — Row Detail
            </span>
          </span>
        </div>

        {/* Scrollable Tab bar */}
        <div className="db-explorer-row-tabbar">
          {tabsOverflow && (
            <button
              className="db-explorer-tab-arrow"
              disabled={!canScrollTabsLeft}
              onClick={scrollTabsLeft}
              title="Previous tabs"
            >‹</button>
          )}
          <div className="db-explorer-tab-list" ref={tabBarRef}>
            {rowDetailTabIds.map((tabId, i) => (
              <button
                key={tabId}
                className={`db-explorer-tab${rowTab === tabId ? ' active' : ''}`}
                onClick={() => setRowTab(tabId)}
              >
                {rowDetailTabs[i]}
              </button>
            ))}
          </div>
          {tabsOverflow && (
            <button
              className="db-explorer-tab-arrow"
              disabled={!canScrollTabsRight}
              onClick={scrollTabsRight}
              title="Next tabs"
            >›</button>
          )}
        </div>

        {/* Tab content */}
        <div className="db-explorer-row-content">
          {rowTab === '__row__' ? (
            <JsonView value={viewRow} defaultExpanded={3} style={{ fontSize: 12 }} />
          ) : (
            <div className="db-explorer-col-detail">
              <div className="db-explorer-col-label">{rowTab}</div>
              {renderCellContent(viewRow[rowTab])}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="db-explorer">
      {/* Sidebar */}
      <div className="db-explorer-sidebar" style={{ width: collapsed ? 0 : sidebarWidth }}>
        <div className="db-explorer-sidebar-head">
          <BackBtn onClick={onBack} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>Tables</span>
          <button className="bs-btn-sm bs-btn-secondary" style={{ marginLeft: 'auto' }} onClick={handleRefresh}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.27" />
            </svg>
            {refreshing ? '…' : ''}
          </button>
        </div>
        <div className="db-explorer-table-list">
          {tables.map(t => (
            <button
              key={t.name}
              className={`db-explorer-table-item${activeTable === t.name ? ' active' : ''}`}
              onClick={() => selectTable(t.name)}
            >
              <span className="db-explorer-table-icon" style={{ background: tableColor(t.name) + '22', color: tableColor(t.name), border: `1px solid ${tableColor(t.name)}55` }}>
                <TableIcon table={t.name} />
              </span>
              <span className="db-explorer-table-meta">
                <span className="db-explorer-table-name">{t.name}</span>
                <span className="db-explorer-table-count">{t.rowCount} row{t.rowCount !== 1 ? 's' : ''}</span>
              </span>
            </button>
          ))}
          {tables.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-secondary, #94a3b8)', fontSize: 11, textAlign: 'center' }}>No tables found</div>
          )}
        </div>
      </div>

      {/* Splitter */}
      <div
        className={`db-explorer-splitter${collapsed ? ' is-collapsed' : ''}`}
        onPointerDown={onSplitterPointerDown}
        onPointerMove={onSplitterPointerMove}
        onPointerUp={onSplitterPointerUp}
      >
        <div className="db-explorer-splitter-grip" />
      </div>

      {/* Content area */}
      <div className="db-explorer-content">
        {!activeTable ? (
          <div className="db-explorer-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
              <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
            <span>Select a table to view its data</span>
          </div>
        ) : (
          <>
            <div className="db-explorer-content-head">
              <span style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="db-explorer-table-icon" style={{ background: tableColor(activeTable) + '22', color: tableColor(activeTable), border: `1px solid ${tableColor(activeTable)}55`, width: 22, height: 22 }}>
                  <TableIcon table={activeTable} />
                </span>
                {activeTable}
                <span style={{ fontSize: 11, color: 'var(--text-secondary, #94a3b8)', fontWeight: 400 }}>
                  ({activeTableInfo?.rowCount ?? 0} row{(activeTableInfo?.rowCount ?? 0) !== 1 ? 's' : ''}, {columns.length} col{columns.length !== 1 ? 's' : ''})
                </span>
                <button
                  title="Refresh row count"
                  onClick={handleRefresh}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: 'var(--text-secondary, #94a3b8)', display: 'inline-flex', alignItems: 'center' }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.27" />
                  </svg>
                </button>
              </span>
              {rows.length > 0 && (
                <button
                  className="bs-btn-sm bs-btn-secondary"
                  style={{ marginLeft: 'auto' }}
                  onClick={handleExportCsv}
                  title="Export table as CSV"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  CSV
                </button>
              )}
            </div>
            {rows.length === 0 ? (
              <div className="db-explorer-empty">
                <span style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)' }}>Table is empty</span>
              </div>
            ) : (
              <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
                <table className="db-explorer-table">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          checked={selected.size === rows.length && rows.length > 0}
                          ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < rows.length; }}
                          onChange={() => {
                            const allIds = rows.map(r => getRowPk(r)).filter((v): v is number | string => v !== null);
                            if (selected.size >= allIds.length && allIds.length > 0) {
                              setSelected(new Set());
                            } else {
                              setSelected(new Set(allIds));
                            }
                          }}
                          style={{ cursor: 'pointer', accentColor: '#6366f1' }}
                        />
                      </th>
                      {columns.map(col => (
                        <th key={col}>
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                            <span>{col}</span>
                            {columnTypes[col] && (
                              <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--text-secondary, #64748b)', fontWeight: 400, textTransform: 'uppercase', opacity: 0.7 }}>
                                {columnTypes[col]}
                              </span>
                            )}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const rid = getRowPk(row);
                      const isChecked = rid !== null && selected.has(rid);
                      return (
                        <tr
                          key={rid ?? i}
                          className={`db-explorer-clickable-row${isChecked ? ' selected' : ''}`}
                          onClick={() => { setViewRow(row); setRowTab('__row__'); }}
                        >
                          <td style={{ width: 32 }} onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => {
                                if (rid === null) return;
                                setSelected(prev => {
                                  const s = new Set(prev);
                                  s.has(rid) ? s.delete(rid) : s.add(rid);
                                  return s;
                                });
                              }}
                              style={{ cursor: 'pointer', accentColor: '#6366f1' }}
                            />
                          </td>
                          {columns.map(col => (
                            <td key={col} title={String(row[col] ?? '')}>
                              <span className="db-explorer-cell-value">
                                {row[col] == null ? <span className="db-explorer-null">NULL</span> : String(row[col]).slice(0, 120)}
                              </span>
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Multiselect HUD */}
                {selected.size > 0 && (
                  <div className="bs-multiselect-hud">
                    <span className="bs-multiselect-hud-count">{selected.size} selected</span>
                    <div className="bs-multiselect-hud-divider" />
                    <button
                      className="bs-multiselect-hud-btn bs-multiselect-hud-btn-danger"
                      onClick={() => setDeleteConfirm(true)}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
                      </svg>
                      Delete
                    </button>
                    <div className="bs-multiselect-hud-divider" />
                    <button className="bs-multiselect-hud-btn bs-multiselect-hud-btn-muted" onClick={() => setSelected(new Set())}>
                      × Deselect
                    </button>
                  </div>
                )}

                {/* Delete confirm dialog */}
                {deleteConfirm && (
                  <div className="db-explorer-overlay">
                    <div className="db-explorer-confirm">
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#dc2626', marginBottom: 8 }}>
                        Delete {selected.size} row{selected.size !== 1 ? 's' : ''}?
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)', marginBottom: 20 }}>
                        This action cannot be undone. The selected rows will be permanently removed from <strong>{activeTable}</strong>.
                      </div>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button className="bs-btn-sm bs-btn-secondary" onClick={() => setDeleteConfirm(false)}>Cancel</button>
                        <button className="bs-btn-sm bs-btn-danger" onClick={handleDelete}>Delete</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
