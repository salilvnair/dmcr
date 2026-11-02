/**
 * The right-click menu for text, everywhere in a DMCR webview (as daakia's RightClickMenu):
 *  - in a Monaco editor: Cut, Copy, Paste, Undo, Redo, Find, Change all, Comment, Format, Fold, Select all, Command palette
 *  - in an input, textarea or contenteditable: Undo, Redo, Cut, Copy, Paste, Select all
 *  - on selected text elsewhere: Copy
 * Paste reads the clipboard through the extension host (see services/clipboard): a VS Code webview may not.
 * Mounted once per webview (EditSupport); elements with a menu of their own keep it (`data-context-menu`).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ContextMenuView, type ContextMenuItem, CutIcon, CopyIcon, PasteIcon, UndoIcon, RedoIcon, SelectAllIcon, SearchIcon,
  WrapLinesIcon, CodeIcon, ChevronRightIcon, ChevronDownIcon, CommandKeyIcon,
} from '@salilvnair/dui';
import { readClipboard } from '../services/clipboard/read-clipboard';
import { installPasteBridge } from '../services/clipboard/paste-bridge';
import { monacoEditorOf, isReadOnly, type MonacoEditor } from '../services/clipboard/monaco-instance';

const C = { cut: 'var(--dm-c-f87171)', copy: 'var(--dm-c-60a5fa)', paste: 'var(--dm-c-34d399)', undo: 'var(--dm-c-a78bfa)', edit: 'var(--dm-c-f59e0b)', nav: 'var(--dm-c-94a3b8)' };
const sep = (id: string): ContextMenuItem => ({ id, label: '', separator: true });

/** Copy text out: the async clipboard where allowed, else the browser's copy of the current selection */
async function writeText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch { document.execCommand('copy'); }
}

/** Runs once the menu has closed and the editor has its focus back */
function inEditor(editor: MonacoEditor, run: () => void | Promise<void>) {
  requestAnimationFrame(() => { editor.focus(); requestAnimationFrame(() => { void run(); }); });
}

function monacoItems(editor: MonacoEditor): ContextMenuItem[] {
  const ro = isReadOnly(editor);
  const sel = editor.getSelection();
  const selected = sel && !sel.isEmpty() ? editor.getModel()?.getValueInRange(sel) ?? '' : '';
  const act = (id: string) => () => inEditor(editor, () => { editor.trigger('contextmenu', id, null); });
  const items: ContextMenuItem[] = [
    { id: 'cut', label: 'Cut', icon: <CutIcon size={14} />, iconColor: C.cut, shortcut: 'Ctrl+X', disabled: ro || !selected,
      onClick: () => inEditor(editor, async () => { await writeText(selected); const s = editor.getSelection(); if (s) { editor.executeEdits('contextmenu', [{ range: s, text: '' }]); } }) },
    { id: 'copy', label: 'Copy', icon: <CopyIcon size={14} />, iconColor: C.copy, shortcut: 'Ctrl+C', disabled: !selected,
      onClick: () => { void writeText(selected); } },
    { id: 'paste', label: 'Paste', icon: <PasteIcon size={14} />, iconColor: C.paste, shortcut: 'Ctrl+V', disabled: ro,
      onClick: () => inEditor(editor, async () => {
        const text = await readClipboard(); const s = editor.getSelection();
        if (text && s) { editor.executeEdits('contextmenu', [{ range: s, text, forceMoveMarkers: true }]); }
      }) },
  ];
  if (!ro) {
    items.push(sep('s1'),
      { id: 'undo', label: 'Undo', icon: <UndoIcon size={14} />, iconColor: C.undo, shortcut: 'Ctrl+Z', onClick: act('undo') },
      { id: 'redo', label: 'Redo', icon: <RedoIcon size={14} />, iconColor: C.undo, shortcut: 'Ctrl+Y', onClick: act('redo') });
  }
  items.push(sep('s2'),
    ro
      ? { id: 'find', label: 'Find', icon: <SearchIcon size={14} />, iconColor: C.copy, shortcut: 'Ctrl+F', onClick: act('actions.find') }
      : { id: 'find', label: 'Find and Replace', icon: <SearchIcon size={14} />, iconColor: C.copy, shortcut: 'Ctrl+H', onClick: act('editor.action.startFindReplaceAction') });
  if (!ro) {
    items.push(
      { id: 'changeAll', label: 'Change All Occurrences', shortcut: 'Ctrl+F2', onClick: act('editor.action.changeAll') },
      { id: 'comment', label: 'Toggle Comment', icon: <CodeIcon size={14} />, iconColor: C.edit, shortcut: 'Ctrl+/', onClick: act('editor.action.commentLine') },
      { id: 'format', label: 'Format Document', icon: <WrapLinesIcon size={14} />, iconColor: C.edit, shortcut: 'Shift+Alt+F', onClick: act('editor.action.formatDocument') });
  }
  items.push(sep('s3'),
    { id: 'foldAll', label: 'Fold All', icon: <ChevronRightIcon size={14} />, iconColor: C.nav, shortcut: 'Ctrl+K Ctrl+0', onClick: act('editor.foldAll') },
    { id: 'unfoldAll', label: 'Unfold All', icon: <ChevronDownIcon size={14} />, iconColor: C.nav, shortcut: 'Ctrl+K Ctrl+J', onClick: act('editor.unfoldAll') },
    sep('s4'),
    { id: 'selectAll', label: 'Select All', icon: <SelectAllIcon size={14} />, iconColor: C.edit, shortcut: 'Ctrl+A', onClick: act('editor.action.selectAll') },
    { id: 'palette', label: 'Command Palette', icon: <CommandKeyIcon size={14} />, iconColor: C.nav, shortcut: 'F1', onClick: act('editor.action.quickCommand') });
  return items;
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

function fieldOf(el: HTMLElement): Field | null {
  if (el.tagName === 'TEXTAREA') { return el; }
  if (el.tagName === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    return ['text', 'search', 'url', 'email', 'password', 'number', 'tel', ''].includes(t) ? el : null;
  }
  return el.isContentEditable ? (el.closest('[contenteditable="true"]') as HTMLElement | null) ?? el : null;
}

function fieldItems(field: Field): ContextMenuItem[] {
  const native = field as HTMLInputElement;
  const isNative = field.tagName === 'INPUT' || field.tagName === 'TEXTAREA';
  const ro = isNative ? native.readOnly || native.disabled : false;
  const selected = isNative
    ? native.value.slice(native.selectionStart ?? 0, native.selectionEnd ?? 0)
    : window.getSelection()?.toString() ?? '';
  const secret = isNative && native.type === 'password';
  const run = (fn: () => void | Promise<void>) => () => { field.focus(); void fn(); };
  return [
    { id: 'undo', label: 'Undo', icon: <UndoIcon size={14} />, iconColor: C.undo, shortcut: 'Ctrl+Z', disabled: ro, onClick: run(() => { document.execCommand('undo'); }) },
    { id: 'redo', label: 'Redo', icon: <RedoIcon size={14} />, iconColor: C.undo, shortcut: 'Ctrl+Y', disabled: ro, onClick: run(() => { document.execCommand('redo'); }) },
    sep('s1'),
    { id: 'cut', label: 'Cut', icon: <CutIcon size={14} />, iconColor: C.cut, shortcut: 'Ctrl+X', disabled: ro || !selected || secret,
      onClick: run(async () => { await writeText(selected); document.execCommand('delete'); }) },
    { id: 'copy', label: 'Copy', icon: <CopyIcon size={14} />, iconColor: C.copy, shortcut: 'Ctrl+C', disabled: !selected || secret,
      onClick: run(() => writeText(selected)) },
    { id: 'paste', label: 'Paste', icon: <PasteIcon size={14} />, iconColor: C.paste, shortcut: 'Ctrl+V', disabled: ro,
      onClick: run(async () => { const text = await readClipboard(); if (text) { field.focus(); document.execCommand('insertText', false, text); } }) },
    sep('s2'),
    { id: 'selectAll', label: 'Select All', icon: <SelectAllIcon size={14} />, iconColor: C.edit, shortcut: 'Ctrl+A',
      onClick: run(() => { if (isNative) { native.select(); } else { document.execCommand('selectAll'); } }) },
  ];
}

/** Mounted once per webview: the Ctrl+V bridge and the right-click menu */
export function EditSupport() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  useEffect(() => installPasteBridge(), []);

  const onContextMenu = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function' || target.closest('[data-context-menu]')) { return; }
    let items: ContextMenuItem[] | null = null;
    const editor = monacoEditorOf(target);
    if (editor) { items = monacoItems(editor); }
    else {
      const field = fieldOf(target);
      if (field) { items = fieldItems(field); }
      else {
        // selected text under the pointer: Copy (a right-click elsewhere keeps what that element does)
        const sel = window.getSelection();
        const text = sel?.toString() ?? '';
        if (text.trim() && sel?.containsNode(target, true)) {
          items = [{ id: 'copy', label: 'Copy', icon: <CopyIcon size={14} />, iconColor: C.copy, shortcut: 'Ctrl+C', onClick: () => { void writeText(text); } }];
        }
      }
    }
    if (!items) { return; }
    // only when a menu of ours will open; capture, before Monaco's own (whose Paste cannot read the clipboard here)
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  useEffect(() => {
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
  }, [onContextMenu]);

  return (
    <ContextMenuView testId="edit-context-menu" open={!!menu} anchorEl={null} position={menu ? { x: menu.x, y: menu.y } : undefined}
      items={menu?.items ?? []} width={280} onClose={() => setMenu(null)} />
  );
}
