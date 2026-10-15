import { useEffect, useMemo, useRef, useState } from 'react';
import { ModalView, ButtonView, CheckboxView, ChipView, LoaderView, TestTubeIcon, WarningTriangleIcon } from '@salilvnair/dui';
import { postMsg } from '../../../vscode';
import { ChangeIdLabel } from './ChangeIdLabel';
import './TestPicker.css';
import { compareChangeIds } from '../../../utils/changeOrder';
import { useIsLightTheme } from '../../../utils/useIsLightTheme';
import { ListToolbar, matchesChange, usePager } from '../../../components/BigList';
import { usePageSize } from '../../../services/listPrefs';

type Pending = { change_id: string; project?: string; kind?: string; release?: string; requested_by?: string; ticket?: string };

/**
 * `test` without --to: pick the pending changes to round-trip, newest first.
 * Each row says how often it already passed a round trip (for its current files). Changes that never
 * passed start ticked, the others unticked. Unticked pending changes older than the newest ticked one
 * are still deployed, as setup without the checks (dmcr test --only), so the ticked ones have what they
 * build on. The test stops at a danger_ change (the DBA runs it): that row and every newer one are disabled.
 */
/** preselect: tick only these (e.g. the row the test icon was clicked on) instead of the never-passed ones */
export function TestPicker({ extra, onRun, onClose, preselect }: { extra: string[]; onRun: (args: string[]) => void; onClose: () => void; preselect?: string[] }) {
  const [items, setItems] = useState<Pending[] | null>(null);
  const [passes, setPasses] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const isLight = useIsLightTheme();
  const pageSize = usePageSize();
  // hundreds pending: find changes, and tick or untick everything the search shows
  const [query, setQuery] = useState('');
  const [tested, setTested] = useState('all');
  const reqId = useRef(`test-pick-${Date.now()}`);
  const envIdx = extra.indexOf('--env');
  const env = envIdx >= 0 ? extra[envIdx + 1] : '';

  useEffect(() => {
    const h = (e: MessageEvent) => {
      if (e.data?.type === 'testPasses' && e.data.payload?.requestId === reqId.current) { setPasses(e.data.payload.passes ?? {}); return; }
      if (e.data?.type !== 'dmcrCaptureResult' || e.data.payload?.captureId !== reqId.current) return;
      const d = e.data.payload.data as unknown;
      if (!Array.isArray(d)) { setError(String((d as { message?: string })?.message ?? 'Could not read the pending changes')); setItems([]); setPasses({}); return; }
      // newest first: the highest change number on top
      const rows = (d as (Pending & { status?: string; dropped?: boolean })[])
        .filter(r => r.status === 'pending' && !r.dropped).sort((a, b) => compareChangeIds(b.change_id, a.change_id));
      setItems(rows);
      postMsg({ type: 'getTestPasses', payload: { requestId: reqId.current, ids: rows.map(r => r.change_id) } });
    };
    window.addEventListener('message', h);
    postMsg({ type: 'runDmcr', payload: { args: ['status', ...(env ? ['--env', env] : []), '--json'], captureId: reqId.current } });
    return () => window.removeEventListener('message', h);
  }, [env]);

  // the oldest pending danger_ change: the test stops there, so it and everything newer can't be picked
  const stopAt = useMemo(() => {
    let s = -1;
    (items ?? []).forEach((it, i) => { if (/(^|_)danger_/i.test(it.change_id)) s = i; });
    return s;
  }, [items]);
  const enabled = (i: number) => i > stopAt;

  // never passed: ticked; passed before (same files): unticked
  useEffect(() => {
    if (items && passes) setChecked(new Set(items.filter((it, i) => enabled(i) && (preselect ? preselect.includes(it.change_id) : !passes[it.change_id])).map(it => it.change_id)));
  }, [items, passes]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string, on: boolean) => setChecked(prev => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });
  const setMany = (ids: string[], on: boolean) => setChecked(prev => { const n = new Set(prev); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });

  // the newest ticked change is --to; unticked pending changes under it run as setup (--only names the ticked ones)
  const list = items ?? [];
  // the rows shown: the search, a page at a time (index i is the row's place in the whole newest-first list)
  const passedOf = (id: string) => (passes?.[id] ?? 0) > 0;
  const found = list.map((it, i) => ({ it, i })).filter(({ it }) => matchesChange(it.change_id, query)
    && (tested === 'all' || (tested === 'tested' ? passedOf(it.change_id) : !passedOf(it.change_id))));
  const { rows: pageRows, pager } = usePager(found, `${query}|${tested}`);
  const newest = list.findIndex(it => checked.has(it.change_id));
  const target = newest >= 0 ? list[newest].change_id : '';
  const span = newest >= 0 ? list.slice(newest) : [];
  const setupCount = span.filter(it => !checked.has(it.change_id)).length;
  const args = !target ? [] : ['test', '--to', target, ...(setupCount ? ['--only', span.filter(it => checked.has(it.change_id)).map(it => it.change_id).reverse().join(',')] : []), ...extra];

  return (
    <ModalView open size="lg" className="tp-modal" onClose={onClose} headerIcon={<TestTubeIcon size={16} />} headerColor="var(--dm-c-10b981)"
      title={`Round-trip test${env ? ` on ${env}` : ''}`}
      subtitle="Deploy, verify, revert and verify each ticked change, compare schema and data, then roll everything back. Newest first."
      footerRight={<>
        <ButtonView variant="ghost" label="Cancel" onClick={onClose} />
        {/* subtle like Commit releases.json: filled green in light mode, green text on the dark button in dark mode */}
        <ButtonView {...(isLight ? { variant: 'primary' as const, accentColor: 'var(--dm-c-10b981)' } : { variant: 'secondary' as const, color: 'var(--dm-c-34d399)' })} disabled={!target} iconLeft={<TestTubeIcon size={13} />}
          label={`Round-trip ${checked.size || ''} change${checked.size === 1 ? '' : 's'}`} onClick={() => { onRun(args); onClose(); }} />
      </>}>
      {!items || !passes ? <LoaderView variant="dots" label="Reading the pending changes" center /> : error ? (
        <div className="tp-note tp-note--warn"><WarningTriangleIcon size={13} />{error}</div>
      ) : !items.length ? (
        <div className="tp-note">Nothing pending{env ? ` on ${env}` : ''}: every change is applied.</div>
      ) : (
        <>
          <div className="tp-note">Changes that never passed a round trip are ticked. Unticked ones under a ticked change are still applied inside the test first (no checks, rolled back with the rest), because the ticked ones build on them. Nothing is deployed.</div>
          {items.length > pageSize && (() => {
            const shownIds = found.filter(({ i }) => enabled(i)).map(({ it }) => it.change_id);
            const nTested = items.filter(it => passedOf(it.change_id)).length;
            return (
              <ListToolbar query={query} onQuery={setQuery} shown={found.length} total={items.length} filter={tested} onFilter={setTested}
                filters={nTested && nTested < items.length ? [{ value: 'all', label: 'All', count: items.length }, { value: 'not', label: 'Not tested', count: items.length - nTested }, { value: 'tested', label: 'Tested', count: nTested }] : undefined}
                right={<span className="tp-bulk">
                  <ButtonView size="sm" variant="ghost" label={`Tick ${query || tested !== 'all' ? 'shown' : 'all'} (${shownIds.length})`} disabled={!shownIds.length} onClick={() => setMany(shownIds, true)} />
                  <ButtonView size="sm" variant="ghost" label={`Untick ${query || tested !== 'all' ? 'shown' : 'all'}`} disabled={!shownIds.some(id => checked.has(id))} onClick={() => setMany(shownIds, false)} />
                </span>} />
            );
          })()}
          <div className="tp-list" role="list">
            {pageRows.map(({ it, i }) => {
              const off = !enabled(i);
              const n = passes[it.change_id] ?? 0;
              const asSetup = !off && !checked.has(it.change_id) && newest >= 0 && i > newest;
              return (
                <label key={it.change_id} role="listitem" className={`tp-row${off ? ' is-off' : ''}${checked.has(it.change_id) ? ' is-on' : ''}`}>
                  <CheckboxView checked={checked.has(it.change_id)} disabled={off} onChange={v => toggle(it.change_id, v)} size="md" accentColor="var(--dm-c-10b981)" />
                  <span className="tp-id"><ChangeIdLabel id={it.change_id} /></span>
                  <span className="tp-meta">
                    {it.kind && <ChipView size="xs" label={it.kind} />}
                    {off
                      ? (i === stopAt
                        ? <ChipView size="xs" label="danger_: the DBA runs it, the test stops here" color="var(--dm-c-ef4444)" />
                        : <ChipView size="xs" label="after a danger_ change: not testable" color="var(--dm-c-94a3b8)" />)
                      : n > 0
                        ? <ChipView size="xs" label={`tested ×${n}`} color="var(--dm-c-10b981)" />
                        : <ChipView size="xs" label="not tested" color="var(--dm-c-f59e0b)" />}
                    {asSetup && <ChipView size="xs" label="applied for the test, not checked" color="var(--dm-c-94a3b8)" />}
                  </span>
                </label>
              );
            })}
            {!found.length && <div className="bl-empty">Nothing matches.</div>}
          </div>
          {pager}
          {/* the exact command, wrapped in the body so the footer keeps its buttons */}
          {target && <div className="tp-cmd"><span className="tp-cmd-label">Runs</span><code>{args.join(' ')}</code></div>}
        </>
      )}
    </ModalView>
  );
}
