import { useRef, useState, useCallback } from 'react';
import { InfoPopupView } from '@salilvnair/dui';
import './FieldHint.css';

interface FieldHintProps {
  text: string;
  example?: string;
}

export function FieldHint({ text, example }: FieldHintProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback(() => setOpen(o => !o), []);
  const close  = useCallback(() => setOpen(false), []);

  const items = example
    ? example.split(',').map(e => ({ code: e.trim(), description: '' }))
    : undefined;

  return (
    <span className="fh-root">
      <button
        ref={btnRef}
        type="button"
        className="fh-trigger"
        onClick={toggle}
        aria-label="Field information"
        tabIndex={0}
      >?</button>
      <InfoPopupView
        open={open}
        onClose={close}
        anchorEl={open ? btnRef.current : null}
        title="Field Info"
        description={text}
        items={items?.filter(i => i.code)}
        width={280}
      />
    </span>
  );
}
