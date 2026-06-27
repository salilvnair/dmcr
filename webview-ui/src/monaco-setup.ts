/**
 * Self-host Monaco Editor — no CDN required.
 * VS Code webview CSP blocks CDN; all workers must be bundled.
 * Mirrors daakia's monaco-setup.ts pattern.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

(window as unknown as Record<string, unknown>).MonacoEnvironment = {
  getWorker(_: string, _label: string): Worker {
    return new EditorWorker();
  },
};

monaco.editor.defineTheme('daakia-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string.key.json',  foreground: '9CDCFE' },
    { token: 'string.value.json', foreground: 'CE9178' },
    { token: 'number',           foreground: 'B5CEA8' },
    { token: 'keyword.json',     foreground: '569CD6' },
    { token: 'string',           foreground: 'CE9178' },
    { token: 'keyword',          foreground: '569CD6' },
    { token: 'comment',          foreground: '6A9955' },
    { token: 'type',             foreground: '4EC9B0' },
    { token: 'identifier',       foreground: '9CDCFE' },
    { token: 'variable',         foreground: '9CDCFE' },
    { token: 'constant',         foreground: '4FC1FF' },
  ],
  colors: {
    'editor.background':                   '#1e1e1e',
    'editor.foreground':                   '#D4D4D4',
    'editor.lineHighlightBackground':      '#2a2a2a',
    'editor.selectionBackground':          '#264f78',
    'editor.inactiveSelectionBackground':  '#3a3d41',
    'editorLineNumber.foreground':         '#858585',
    'editorLineNumber.activeForeground':   '#C6C6C6',
    'editorCursor.foreground':             '#AEAFAD',
    'editorWidget.background':             '#252526',
    'editorSuggestWidget.background':      '#252526',
    'editorSuggestWidget.border':          '#454545',
    'list.hoverBackground':                '#2a2d2e',
    'input.background':                    '#3c3c3c',
    'focusBorder':                         '#6366f1',
  },
});

monaco.editor.defineTheme('daakia-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'string.key.json',  foreground: '0451a5' },
    { token: 'string.value.json', foreground: 'a31515' },
    { token: 'number',           foreground: '09885a' },
    { token: 'keyword.json',     foreground: '0000ff' },
    { token: 'string',           foreground: 'a31515' },
    { token: 'keyword',          foreground: '0000ff' },
    { token: 'comment',          foreground: '008000' },
    { token: 'type',             foreground: '267f99' },
    { token: 'identifier',       foreground: '001080' },
    { token: 'variable',         foreground: '001080' },
    { token: 'constant',         foreground: '0070c1' },
  ],
  colors: {
    'editor.background':                  '#ffffff',
    'editor.foreground':                  '#000000',
    'editor.lineHighlightBackground':     '#f5f5f5',
    'editor.selectionBackground':         '#add6ff',
    'editor.inactiveSelectionBackground': '#e5ebf1',
    'editorLineNumber.foreground':        '#237893',
    'editorLineNumber.activeForeground':  '#0b216f',
    'editorCursor.foreground':            '#000000',
    'editorWidget.background':            '#f3f3f3',
    'list.hoverBackground':               '#f0f0f0',
    'input.background':                   '#ffffff',
    'focusBorder':                        '#6366f1',
  },
});

loader.config({ monaco });

export { monaco };

export function applyMonacoTheme(theme: 'dark' | 'light') {
  monaco.editor.setTheme(theme === 'dark' ? 'daakia-dark' : 'daakia-light');
}
