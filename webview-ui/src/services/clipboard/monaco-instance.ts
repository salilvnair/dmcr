/**
 * The Monaco editor a DOM node belongs to, for the paste bridge and the right-click menu.
 *
 * dui's monaco-setup (main.tsx) puts the Monaco every editor here is created with on `window.monaco`, so its
 * getEditors() knows them; read from there, the pages without an editor do not bundle Monaco for nothing.
 * The match is loose about direction: Monaco's DOM node and the `.monaco-editor` found from a target are not
 * always the same node, depending on which part of the editor was under the pointer.
 */
import type * as Monaco from 'monaco-editor';

export type MonacoEditor = Monaco.editor.ICodeEditor;

const monacoGlobal = (): typeof Monaco | undefined => (window as unknown as { monaco?: typeof Monaco }).monaco;

export function monacoEditorOf(el: Element | null): MonacoEditor | null {
  const container = el?.closest?.('.monaco-editor');
  const m = monacoGlobal();
  if (!container || !m) { return null; }
  for (const editor of m.editor.getEditors()) {
    try {
      const node = editor.getDomNode();
      if (node && (node === container || node.contains(container) || container.contains(node))) { return editor; }
    } catch { /* an editor being disposed has no DOM node */ }
  }
  return null;
}

/** Whether the editor refuses edits (the resolved option, not the raw one passed in) */
export function isReadOnly(editor: MonacoEditor): boolean {
  const id = monacoGlobal()?.editor.EditorOption.readOnly;
  return typeof id === 'number' ? !!editor.getOption(id) : false;
}
