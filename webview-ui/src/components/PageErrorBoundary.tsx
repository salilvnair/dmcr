import React from 'react';
import { ButtonView, RefreshIcon, WarningTriangleIcon } from '@salilvnair/dui';
import { reloadPage } from '../vscode';

/** A page that throws while rendering shows what went wrong and a Reload, instead of taking the whole panel down (a black page). */
export class PageErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('[dmcr] page crashed:', error, info.componentStack); }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ maxWidth: 520, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
          <WarningTriangleIcon size={34} style={{ color: 'var(--dm-c-f59e0b)' }} />
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>This page could not be shown</div>
          <code style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{error.message}</code>
          <ButtonView size="md" variant="secondary" iconLeft={<RefreshIcon size={13} />} label="Reload" onClick={reloadPage} />
        </div>
      </div>
    );
  }
}
