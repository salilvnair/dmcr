import { useEffect, useState, type ReactNode } from 'react';
import { TextInputView, SegmentedControlView, TablePaginationView, SearchIcon, CloseIcon, IconButtonView } from '@salilvnair/dui';
import './BigList.css';
import { PAGE_SIZES, usePageSize } from '../services/listPrefs';

/**
 * Long change lists (hundreds or thousands of changes): a search box and filters above the list, and the rows
 * a page at a time with page numbers under it. The page size is Settings › Lists (10 by default); a list that
 * fits on one page shows as before, without the bar or the footer.
 */
export type ListFilter = { value: string; label: string; count?: number };

/** A change id matches when every word of the query is in it; a number matches the folder number from its start (10 → 010_, 100_, 1000_). */
export function matchesChange(id: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const lid = id.toLowerCase();
  return q.split(/\s+/).every(w => (/^\d+$/.test(w) ? lid.replace(/^0+/, '').startsWith(w.replace(/^0+/, '')) || lid.startsWith(w) : lid.includes(w)));
}

export function ListToolbar({ query, onQuery, filters, filter, onFilter, shown, total, placeholder = 'Find a change: number or name', right }: {
  query: string; onQuery: (q: string) => void;
  filters?: ListFilter[]; filter?: string; onFilter?: (v: string) => void;
  shown: number; total: number; placeholder?: string; right?: ReactNode;
}) {
  return (
    <div className="bl-bar">
      <span className="bl-search">
        <TextInputView size="md" value={query} placeholder={placeholder} iconLeft={<SearchIcon size={12} />}
          onChange={e => onQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); onQuery(''); } }} />
        {query && <IconButtonView size="sm" variant="ghost" icon={<CloseIcon size={11} />} title="Clear" onClick={() => onQuery('')} />}
      </span>
      {filters && filters.length > 1 && onFilter && (
        <SegmentedControlView size="md" variant="rounded" accentColor="var(--bs-accent)" value={filter ?? filters[0].value} onChange={onFilter}
          options={filters.map(f => ({ value: f.value, label: f.count === undefined ? f.label : `${f.label} ${f.count}` }))} />
      )}
      <span className="bl-count">{shown === total ? `${total} change${total === 1 ? '' : 's'}` : `${shown} of ${total}`}</span>
      {right}
    </div>
  );
}

/**
 * The rows of one page, and the page footer (rows per page, "1–25 of 640", page numbers). Back to page 1 when
 * `resetKey` (the search and filters) changes. Up to `threshold` rows: every row, no footer.
 */
export function usePager<T>(items: T[], resetKey: string, threshold?: number): { rows: T[]; pager: ReactNode } {
  const defaultSize = usePageSize();
  const [page, setPage] = useState(1);
  // this list's size: the Settings default until you pick another in its footer (a new default resets it)
  const [size, setSize] = useState(defaultSize);
  useEffect(() => { setSize(defaultSize); setPage(1); }, [defaultSize]);
  useEffect(() => { setPage(1); }, [resetKey]);
  if (threshold === undefined) threshold = defaultSize;
  if (items.length <= threshold) return { rows: items, pager: null };
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(page, totalPages);
  return {
    rows: items.slice((p - 1) * size, p * size),
    pager: (
      <TablePaginationView className="bl-pager" size="md" color="var(--bs-accent)" page={p} totalRows={items.length} rowsPerPage={size}
        rowsPerPageOptions={[...PAGE_SIZES]} onPageChange={setPage} onRowsPerPageChange={n => { setSize(n); setPage(1); }} />
    ),
  };
}

/** A filter of a result list: its label and which rows it keeps (rows it keeps none of are not offered). */
export type RowFilter<T> = { value: string; label: string; keep: (item: T) => boolean };

/**
 * A result list (verify all, test, deploy, history …): above `threshold` rows, a search bar with the filters
 * (each with its count; "All" first) and the rows a page at a time. A short list: every row, no bar.
 */
export function usePagedRows<T>(items: T[], idOf: (item: T) => string, filters: RowFilter<T>[] = [], thresholdArg?: number): { rows: T[]; bar: ReactNode; more: ReactNode } {
  const pageSize = usePageSize();
  const threshold = thresholdArg ?? pageSize;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const big = items.length > threshold;
  const offered = filters.map(f => ({ ...f, count: big ? items.filter(f.keep).length : 0 })).filter(f => f.count > 0);
  const active = offered.find(f => f.value === filter);
  const matched = big ? items.filter(it => (!active || active.keep(it)) && matchesChange(idOf(it), query)) : items;
  const { rows, pager } = usePager(matched, `${filter}|${query}`, big ? 0 : threshold);
  if (!big) return { rows: items, bar: null, more: null };
  return {
    rows,
    bar: <ListToolbar query={query} onQuery={setQuery} shown={matched.length} total={items.length} filter={active ? filter : 'all'} onFilter={setFilter}
      filters={offered.length ? [{ value: 'all', label: 'All', count: items.length }, ...offered.map(f => ({ value: f.value, label: f.label, count: f.count }))] : undefined} />,
    more: matched.length ? pager : <div className="bl-empty">Nothing matches.</div>,
  };
}
