import { useEffect, useRef } from 'react';
import { EditorView, ResizablePanelView } from '@salilvnair/dui';
import './SqlEditor.css';

type Props = {
  value: string;
  onChange: (val: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
};

/**
 * Editable SQL: the dui code editor (Monaco), so the caret, arrow keys and selection are the
 * editor's own. (It was a transparent textarea over a highlighted copy, which drifted apart:
 * the caret and the selection sat beside the text.) It types like a plain field: no auto-closed
 * brackets or quotes, no auto-indent (what you type is what you get), Enter starts a new line, Tab accepts a suggestion.
 */
export default function SqlEditor({ value, onChange, onBlur, placeholder, className }: Props) {
  // the editor keeps its first blur callback: call the latest one through a ref
  const blurRef = useRef(onBlur);
  useEffect(() => { blurRef.current = onBlur; }, [onBlur]);
  return (
    <div className={`sql-editor${className ? ' ' + className : ''}`}>
      {/* drag the bottom edge to make it as tall as you need */}
      <ResizablePanelView defaultHeight={300} minHeight={140} maxHeight={4000}>
      <EditorView
        value={value}
        onChange={onChange}
        language="sql"
        height="100%"
        fontSize={12.5}
        wordWrap
        placeholder={placeholder}
        editorOptions={{ minimap: false, scrollBeyondLastLine: false, acceptSuggestionOnEnter: 'off', autoClosing: false, autoIndent: 'none' }}
        onEditorMount={(editor: { onDidBlurEditorText?: (cb: () => void) => void }) => {
          editor.onDidBlurEditorText?.(() => blurRef.current?.());
        }}
      />
      </ResizablePanelView>
    </div>
  );
}
