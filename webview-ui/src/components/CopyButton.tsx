import { useEffect, useRef, useState } from 'react';
import { ButtonView, CheckIcon, CopyIcon, IconButtonView } from '@salilvnair/dui';
import './CopyButton.css';

/** The copy icon, or (just copied) a green check that pops in: every copy button in DMCR shows the same */
export function CopyIconSwap({ copied, size = 13 }: { copied: boolean; size?: number }) {
  return copied
    ? <span className="dm-copied" key="done"><CheckIcon size={size} /></span>
    : <CopyIcon size={size} />;
}

/**
 * A button that copies `text` (or runs `onCopy`) and turns into a green check for a moment.
 * Icon only, unless it has a `label` ("Copy" becomes "Copied").
 */
export function CopyButton({ text, onCopy, size = 13, title = 'Copy', buttonSize = 'sm', label, style }: {
  text?: string; onCopy?: () => void | Promise<void>; size?: number; title?: string; buttonSize?: 'sm' | 'md';
  label?: string; style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      if (onCopy) await onCopy();
      else await navigator.clipboard.writeText(text ?? '');
    } catch { return; }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  const icon = <CopyIconSwap copied={copied} size={size} />;
  return label
    ? <ButtonView variant="secondary" iconLeft={icon} label={copied ? 'Copied' : label} title={title} style={style} onClick={() => void copy()} />
    : <IconButtonView size={buttonSize} variant="ghost" icon={icon} title={copied ? 'Copied' : title} onClick={() => void copy()} />;
}
