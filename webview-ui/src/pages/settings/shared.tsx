import { useState } from 'react';
import { ButtonView, SelectInputView, WrenchToolIcon } from '@salilvnair/dui';
import { postMsg } from '../../vscode';
import { WarnIcon } from './icons';

export function SqliteBanner({ error }: { error?: string }) {
  const [rebuilding, setRebuilding] = useState(false);
  const handleFix = () => {
    setRebuilding(true);
    postMsg({ type: 'rebuildSqlite' });
    setTimeout(() => setRebuilding(false), 5000);
  };
  return (
    <div className="bs-sqlite-banner">
      <WarnIcon style={{ flexShrink: 0, marginTop: 2, color: '#fbbf24', width: 16, height: 16 }} />
      <div className="bs-sqlite-banner-body">
        <div>
          <strong>SQLite unavailable</strong> -- native binary ABI mismatch.
          Click Install SQLite on the Home page or fix below.
        </div>
        {error && (
          <div style={{ fontSize: 10.5, color: 'var(--text-secondary, #94a3b8)', marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>
            {error.slice(0, 120)}
          </div>
        )}
        <div className="bs-sqlite-banner-actions">
          <ButtonView
            variant="secondary"
            iconLeft={<WrenchToolIcon size={13} />}
            loading={rebuilding}
            label={rebuilding ? 'Rebuilding...' : 'Fix SQLite'}
            onClick={handleFix}
            disabled={rebuilding}
          />
        </div>
      </div>
    </div>
  );
}

/* DtSelect - env picker select (dui SelectInputView) */
interface DtOption {
  value: string;
  label: string;
  badge?: string;
  badgeColor?: string;
}

export function DtSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: DtOption[] }) {
  const selectOptions = options.map(o => ({
    value: o.value,
    label: o.label,
    ...(o.badge ? { badge: { label: o.badge, color: o.badgeColor ?? '#818cf8' } } : {}),
  }));
  return (
    <SelectInputView size="md"
      value={value}
      onChange={onChange}
      options={selectOptions}
      style={{ minWidth: 180 }}
    />
  );
}
