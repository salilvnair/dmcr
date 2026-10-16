import { useEffect, useState } from 'react';
import { ButtonView, SelectInputView, CheckCircleIcon } from '@salilvnair/dui';
import { ListsIcon } from './icons';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, setPageSize, usePageSize } from '../../services/listPrefs';
import './DmcrConfigPanel.css';
import { FieldHint } from '../../components/FieldHint';

/** Settings > General: app-wide preferences (how DMCR Web itself behaves, not your databases). */
export function ListsPanel() {
  const saved = usePageSize();
  const [size, setSize] = useState(saved);
  useEffect(() => { setSize(saved); }, [saved]);
  const dirty = size !== saved;
  return (
    <div className="bs-settings-pane dc-pane">
      <div className="dc-title">
        <ListsIcon className="bs-ico-sm" />
        <h3 className="bs-settings-h3" style={{ margin: 0 }}>General</h3>
        <span className="dc-title-sub">How DMCR itself looks and behaves</span>
      </div>

      <section className="dc-card">
        <div className="dc-card-head">
          <span className="dc-card-icon"><ListsIcon width={15} height={15} /></span>
          <div className="dc-card-titles"><b>Long lists</b><span>Rows per page in Releases, Runner results and previews</span></div>
        </div>
        <div className="dc-card-body">
          <div className="dc-row">
            <label className="dc-row-label">Rows per page<FieldHint title="Rows per page" text="Lists longer than this get search, filters and page numbers; each list's footer can still show more" /></label>
            <div className="dc-row-ctl dc-inline">
              <span style={{ width: 170 }}>
                <SelectInputView size="md" width="100%" value={String(size)} onChange={v => setSize(Number(v))}
                  options={PAGE_SIZES.map(n => ({ value: String(n), label: `${n} rows${n === DEFAULT_PAGE_SIZE ? ' (default)' : ''}` }))} />
              </span>
              <ButtonView label={dirty ? 'Save' : 'Saved'} variant={dirty ? 'primary' : 'ghost'} accentColor="var(--dm-c-6366f1)" disabled={!dirty}
                iconLeft={dirty ? undefined : <CheckCircleIcon size={13} />} onClick={() => setPageSize(size)} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
