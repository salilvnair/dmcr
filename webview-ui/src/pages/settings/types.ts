import type { AppTheme, SettingsSnapshot, CeAuditEntry } from '../../types';
import type { ToastData } from '../../App';
import type { DbInfoPayload, SystemInfoPayload } from '../../types';

/* ── Module-level JS error capture (survives re-renders) ── */
export interface CapturedJsError {
  type: 'error' | 'unhandledrejection';
  message: string;
  source?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  timestamp: string;
}
export const _capturedJsErrors: CapturedJsError[] = [];
window.addEventListener('error', (e: ErrorEvent) => {
  _capturedJsErrors.push({
    type: 'error',
    message: e.message,
    source: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error?.stack,
    timestamp: new Date().toISOString(),
  });
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  _capturedJsErrors.push({
    type: 'unhandledrejection',
    message: e.reason?.message ?? String(e.reason),
    stack: e.reason?.stack,
    timestamp: new Date().toISOString(),
  });
});

export interface Props {
  snapshot: SettingsSnapshot | null;
  onSnapshotChange: (s: SettingsSnapshot) => void;
  addToast: (msg: string, type?: ToastData['type']) => void;
  dbInfo?: DbInfoPayload | null;
  systemInfo?: SystemInfoPayload | null;
  aiFootprint?: { entries: CeAuditEntry[]; limit: number } | null;
  initialSection?: Section;
  theme?: AppTheme;
  onThemeChange?: (t: AppTheme) => void;
}

export type Section = 'getting-started' | 'quickref' | 'llm' | 'db' | 'devtools' | 'mcp' | 'workspace' | 'danger' | 'theme' | 'prompts' | 'ai-features' | 'sql-policies' | 'conv-chips';

export interface LlmProps {
  snapshot: SettingsSnapshot;
  onSnapshotChange: (s: SettingsSnapshot) => void;
  addToast: (msg: string, type?: ToastData['type']) => void;
}
