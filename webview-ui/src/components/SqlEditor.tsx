import { useRef, useCallback } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import sqlLang from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import './SqlEditor.css';

SyntaxHighlighter.registerLanguage('sql', sqlLang);

type Props = {
  value: string;
  onChange: (val: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
};

/**
 * Editable SQL textarea with syntax-highlighted overlay.
 * Textarea is transparent; SyntaxHighlighter renders behind it.
 */
export default function SqlEditor({ value, onChange, onBlur, placeholder, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLDivElement>(null);

  const syncScroll = useCallback(() => {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  }, []);

  return (
    <div className={`sql-editor${className ? ' ' + className : ''}`} ref={wrapRef}>
      {/* Highlighted layer (behind) */}
      <div className="sql-editor-highlight" ref={preRef} aria-hidden>
        <SyntaxHighlighter
          language="sql"
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: 'var(--sql-editor-pad-y, 12px) var(--sql-editor-pad-x, 14px)',
            background: 'transparent',
            fontSize: 'var(--sql-editor-font-size, 12px)',
            lineHeight: 'var(--sql-editor-line-height, 1.6)',
            fontFamily: "var(--sql-editor-font-family, ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace)",
            minHeight: '100%',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflow: 'hidden',
          }}
          wrapLongLines
        >
          {value || ' '}
        </SyntaxHighlighter>
      </div>

      {/* Editable textarea (on top, transparent text) */}
      <textarea
        ref={taRef}
        className="sql-editor-textarea"
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        onScroll={syncScroll}
        spellCheck={false}
        placeholder={placeholder}
      />
    </div>
  );
}
