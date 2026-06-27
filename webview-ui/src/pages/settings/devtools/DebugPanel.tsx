import React, { useState } from 'react';
import type { CeAuditEntry, SystemInfoPayload, DbInfoPayload } from '../../../types';
import JsonView from '../../../components/JsonView';
import { _capturedJsErrors } from '../types';
import { BackBtn } from './BackBtn';

/* ============================================================
 * Debug Snapshot Panel
 * ============================================================ */
export function DebugPanel({ systemInfo, aiFootprint, dbInfo, onBack }: {
  systemInfo?: SystemInfoPayload | null;
  aiFootprint?: { entries: CeAuditEntry[]; limit: number } | null;
  dbInfo?: DbInfoPayload | null;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const snapshot = {
    timestamp: new Date().toISOString(),
    dmcr: {
      version: '2.0',
      extensionPath: systemInfo?.extensionPath ?? dbInfo?.extensionPath ?? 'unknown',
    },
    sqlite: {
      ok: !!dbInfo,
      dbPath: dbInfo?.dbPath ?? 'unknown',
      dbSizeBytes: dbInfo?.dbSizeBytes ?? 0,
      dbSizeHuman: dbInfo?.dbSizeBytes ? `${(dbInfo.dbSizeBytes / 1024).toFixed(1)} KB` : 'unknown',
      sqliteVersion: dbInfo?.sqliteVersion ?? 'unknown',
      tableCount: dbInfo?.tables?.length ?? 0,
      tables: dbInfo?.tables ?? [],
    },
    ai_footprint: {
      totalEntries: aiFootprint?.entries?.length ?? 0,
      limitSetting: aiFootprint?.limit ?? 50,
      recentCalls: (aiFootprint?.entries ?? []).slice(0, 10).map(e => ({
        audit_id: e.audit_id,
        conversation_id: e.conversation_id,
        stage: e.stage,
        model: e.model,
        duration_ms: e.duration_ms,
        error: e.error ?? null,
        created_at: e.created_at,
        user_prompt_preview: e.user_prompt?.slice(0, 120),
      })),
    },
    runtime: {
      vscodeVersion: systemInfo?.vscodeVersion ?? 'unknown',
      appName: systemInfo?.appName ?? 'unknown',
      appHost: systemInfo?.appHost ?? 'unknown',
      language: systemInfo?.language ?? 'unknown',
      remoteName: systemInfo?.remoteName ?? 'local',
      shell: systemInfo?.shell ?? 'unknown',
      nodeVersion: systemInfo?.versions?.node ?? 'unknown',
      electronVersion: systemInfo?.versions?.electron ?? 'unknown',
      v8Version: systemInfo?.versions?.v8 ?? 'unknown',
      opensslVersion: systemInfo?.versions?.openssl ?? 'unknown',
      uvVersion: (systemInfo?.versions as any)?.uv ?? 'unknown',
    },
    memory: {
      heapUsed: systemInfo?.heapUsed ?? 0,
      heapTotal: systemInfo?.heapTotal ?? 0,
      heapUsedPct: systemInfo?.heapTotal ? `${((systemInfo.heapUsed / systemInfo.heapTotal) * 100).toFixed(1)}%` : 'unknown',
      rss: systemInfo?.rss ?? 0,
      external: systemInfo?.external ?? 0,
      arrayBuffers: systemInfo?.arrayBuffers ?? 0,
      totalSystemMem: systemInfo?.totalMemBytes ?? 0,
      freeSystemMem: systemInfo?.freeMemBytes ?? 0,
      systemMemUsedPct: systemInfo?.totalMemBytes ? `${(((systemInfo.totalMemBytes - systemInfo.freeMemBytes) / systemInfo.totalMemBytes) * 100).toFixed(1)}%` : 'unknown',
    },
    cpu: {
      model: systemInfo?.cpuModel ?? 'unknown',
      cores: systemInfo?.cpuCount ?? 0,
      speedMhz: systemInfo?.cpuSpeed ?? 0,
      uptimeSec: systemInfo?.uptime ?? 0,
      uptimeHuman: systemInfo?.uptime ? `${Math.floor(systemInfo.uptime / 3600)}h ${Math.floor((systemInfo.uptime % 3600) / 60)}m` : 'unknown',
    },
    os: {
      platform: systemInfo?.platform ?? 'unknown',
      release: systemInfo?.release ?? 'unknown',
      arch: systemInfo?.arch ?? 'unknown',
      hostname: systemInfo?.hostname ?? 'unknown',
    },
    paths: {
      extensionRoot: systemInfo?.extensionPath ?? dbInfo?.extensionPath ?? 'unknown',
      homeDir: systemInfo?.homeDir ?? 'unknown',
      tmpDir: systemInfo?.tmpDir ?? 'unknown',
      dbPath: dbInfo?.dbPath ?? 'unknown',
    },
    ui_state: (window as any).__dmcrUiSnapshot ?? 'unavailable',
    jsErrors: _capturedJsErrors.length > 0
      ? _capturedJsErrors.map(e => ({ ...e }))
      : 'none captured this session',
  };

  const json = JSON.stringify(snapshot, null, 2);

  function handleCopy() {
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="bs-settings-pane" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="bs-settings-section-head">
        <BackBtn onClick={onBack} />
        <span style={{ fontSize: 16 }}>🐛</span>
        <h3 className="bs-settings-h3">Debug Snapshot</h3>
        <button className="bs-btn bs-btn-primary" style={{ marginLeft: 'auto' }} onClick={handleCopy}>
          {copied ? '✓ Copied!' : 'Copy JSON'}
        </button>
      </div>
      <p className="bs-hint" style={{ marginBottom: 12 }}>Copy this JSON and paste it to share diagnostic info.</p>
      <div className="bs-debug-json-wrap" style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        borderRadius: 8,
        padding: '14px 16px',
      }}>
        <JsonView value={snapshot} collapsible defaultExpanded={2} />
      </div>
    </div>
  );
}
