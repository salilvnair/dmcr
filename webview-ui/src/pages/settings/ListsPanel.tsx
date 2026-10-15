import { useEffect, useState } from 'react';
import { ButtonView, SelectInputView, CheckCircleIcon } from '@salilvnair/dui';
import { ListsIcon } from './icons';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, setPageSize, usePageSize } from '../../services/listPrefs';

/** Settings › Lists: how many rows a long list shows per page (a dropdown, applied with Save). */
export function ListsPanel() {
  const saved = usePageSize();
  const [size, setSize] = useState(saved);
  useEffect(() => { setSize(saved); }, [saved]);
  const dirty = size !== saved;
  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <ListsIcon className="bs-ico-sm" style={{ color: 'var(--bs-accent-muted)' }} />
        <span>Lists</span>
      </div>
      <div className="bs-field-group" style={{ marginBottom: 20 }}>
        <label className="bs-label">Rows per page</label>
        <p className="bs-hint" style={{ marginBottom: 8 }}>
          Long lists (the Releases changes, Runner results like status, verify all, test and deploy, the round-trip test picker and the
          deploy and rollback previews) show this many rows per page, with search, filters and page numbers once they have more.
          A list&rsquo;s own footer can show more for that list. Default {DEFAULT_PAGE_SIZE}.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ width: 160 }}>
            <SelectInputView size="md" width="100%" value={String(size)} onChange={v => setSize(Number(v))}
              options={PAGE_SIZES.map(n => ({ value: String(n), label: `${n} rows${n === DEFAULT_PAGE_SIZE ? ' (default)' : ''}` }))} />
          </span>
          <ButtonView
            label={dirty ? 'Save' : 'Saved'}
            variant={dirty ? 'primary' : 'ghost'}
            accentColor="var(--dm-c-6366f1)"
            disabled={!dirty}
            iconLeft={dirty ? undefined : <CheckCircleIcon size={13} />}
            onClick={() => setPageSize(size)}
          />
        </div>
      </div>
    </div>
  );
}
