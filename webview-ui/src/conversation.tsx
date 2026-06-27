import React from 'react';
import ReactDOM from 'react-dom/client';
import ConversationPage from './pages/ConversationPage';
import './index.css';

// Acquire VS Code API before any React renders — must be called at most once.
// DmcrPanel's bootstrap script already stores it on window.__DMCR_VSCODE_API__,
// but this entry is used by a *separate* WebviewPanel so we acquire it fresh.
declare function acquireVsCodeApi(): unknown;
if (!(window as any).__DMCR_VSCODE_API__) {
  try {
    (window as any).__DMCR_VSCODE_API__ = acquireVsCodeApi();
  } catch {
    // In browser dev mode acquireVsCodeApi is not available — handled by vscode.ts mock
  }
}

document.documentElement.setAttribute('data-theme', 'dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConversationPage />
  </React.StrictMode>,
);
