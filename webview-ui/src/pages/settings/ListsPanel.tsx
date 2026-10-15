import { RadioCardView } from '@salilvnair/dui';
import { ListsIcon } from './icons';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, setPageSize, usePageSize } from '../../services/listPrefs';

/** Settings › Lists: how many rows a long list shows per page. */
export function ListsPanel() {
  const size = usePageSize();
  return (
    <div className="bs-settings-pane">
      <div className="bs-settings-section-head">
        <ListsIcon className="bs-ico-sm" style={{ color: 'var(--bs-accent-muted)' }} />
        <span>Lists</span>
      </div>
      <p className="theme-note">
        Long lists (the Releases changes, Runner results like status, verify all, test and deploy, the round-trip test picker and the
        deploy and rollback previews) show this many rows per page, with search, filters and page numbers once they have more.
        A list's own footer can show more for that list. Default {DEFAULT_PAGE_SIZE}.
      </p>
      <div className="theme-section-label">Rows per page</div>
      <RadioCardView size="md" columns={6} accentColor="var(--bs-accent)" value={String(size)} onChange={v => setPageSize(Number(v))}
        options={PAGE_SIZES.map(n => ({ value: String(n), label: String(n), description: n === DEFAULT_PAGE_SIZE ? 'Default' : n >= 50 ? 'Long pages' : 'rows' }))} />
    </div>
  );
}
