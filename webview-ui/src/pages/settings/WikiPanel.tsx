import { useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownView, SearchInputView, SelectInputView, BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon } from '@salilvnair/dui';
// the one DMCR Wiki: the same file the Assistant searches (src/forms/llm/prompts/DmcrWiki.md, copied to dist/)
import wikiSource from '../../../../src/forms/llm/prompts/DmcrWiki.md?raw';
import '../WikiPanel.css';

type Page = { id: string; group: string; title: string; body: string };

/** A heading's anchor as GitHub writes it (what the wiki's own links use): lower case, punctuation dropped, spaces to - */
const slug = (text: string) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
/** The ### / #### headings of a page, as anchors */
const subAnchors = (p: Page) => [...p.body.matchAll(/^#{3,4} (.+)$/gm)].map(m => slug(m[1]));

/** "# Group" headings group the pages; each "## Page" is one page, down to the next ## or # */
function parseWiki(md: string): Page[] {
  const pages: Page[] = [];
  let group = '';
  let cur: Page | null = null;
  let inFence = false;
  const used = new Set<string>();
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const g = !inFence && /^# (.+)$/.exec(line);
    const p = !inFence && /^## (.+)$/.exec(line);
    if (g) { if (cur) pages.push(cur); cur = null; group = g[1].trim(); continue; }
    if (p) {
      if (cur) pages.push(cur);
      let id = slug(p[1]) || 'page';
      while (used.has(id)) id += '-2';
      used.add(id);
      cur = { id, group, title: p[1].trim(), body: '' };
      continue;
    }
    if (cur) cur.body += `${line}\n`;
  }
  if (cur) pages.push(cur);
  return pages.map(x => ({ ...x, body: x.body.trim() }));
}

const PAGES = parseWiki(wikiSource);
const KEY = 'dmcr.wiki.page';

/** The DMCR Wiki: Settings › DMCR Wiki, and the sidebar view (sidebar: the pages in a dropdown). */
export function WikiPanel({ sidebar = false }: { sidebar?: boolean }) {
  const [pageId, setPageId] = useState(() => {
    try { const saved = localStorage.getItem(KEY); if (saved && PAGES.some(p => p.id === saved)) return saved; } catch { /* no storage */ }
    return PAGES[0]?.id ?? '';
  });
  const [query, setQuery] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  // a section to scroll to once its page shows (a link to a ### heading)
  const [anchor, setAnchor] = useState('');

  useEffect(() => { try { localStorage.setItem(KEY, pageId); } catch { /* no storage */ } }, [pageId]);
  // a new page starts at its top, or at the section a link named
  const shownPage = useRef('');
  useEffect(() => {
    if (shownPage.current !== pageId) {
      shownPage.current = pageId;
      bodyRef.current?.scrollTo({ top: 0 }); (bodyRef.current?.closest('.bs-settings-content') as HTMLElement | null)?.scrollTo({ top: 0 });
    }
    if (!anchor) return;
    // the page's markdown renders a moment later: look for the heading for up to a second
    let tries = 0;
    const timer = setInterval(() => {
      const heading = [...(bodyRef.current?.querySelectorAll('h3, h4') ?? [])].find(h => slug(h.textContent ?? '') === anchor);
      if (heading || ++tries > 20) { clearInterval(timer); heading?.scrollIntoView({ block: 'start' }); setAnchor(''); }
    }, 50);
    return () => clearInterval(timer);
  }, [pageId, anchor]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A link inside the wiki (#page or #section): open that page there, never leave the panel */
  const onLinkClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href') ?? '';
    if (!href.startsWith('#')) return;
    e.preventDefault();
    const target = decodeURIComponent(href.slice(1)).toLowerCase();
    const to = PAGES.find(p => p.id === target) ?? PAGES.find(p => subAnchors(p).includes(target));
    if (!to) return;
    if (to.id !== target) setAnchor(target);
    setPageId(to.id);
  };

  // search: every word must be in the page's title or text; title matches first
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => {
    if (!words.length) return PAGES;
    const hit = PAGES.filter(p => words.every(w => `${p.title}\n${p.body}`.toLowerCase().includes(w)));
    return hit.sort((a, b) => Number(words.every(w => b.title.toLowerCase().includes(w))) - Number(words.every(w => a.title.toLowerCase().includes(w))));
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    const out: { name: string; pages: Page[] }[] = [];
    for (const p of shown) {
      const g = words.length ? 'Results' : p.group;
      const last = out[out.length - 1];
      if (last && last.name === g) last.pages.push(p); else out.push({ name: g, pages: [p] });
    }
    return out;
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const idx = PAGES.findIndex(p => p.id === pageId);
  const page = PAGES[idx] ?? PAGES[0];
  const prev = idx > 0 ? PAGES[idx - 1] : null;
  const next = idx >= 0 && idx < PAGES.length - 1 ? PAGES[idx + 1] : null;

  if (!page) return <div className="wk-empty">The wiki is empty.</div>;

  return (
    <div className={`wk${sidebar ? ' wk--sidebar' : ''}`}>
      {sidebar ? (
        <div className="wk-top">
          <SelectInputView size="md" width="100%" value={page.id} onChange={setPageId}
            options={PAGES.map(p => ({ value: p.id, label: `${p.group} › ${p.title}` }))} />
        </div>
      ) : (
        <nav className="wk-nav">
          <div className="wk-nav-head"><BookOpenIcon size={15} />DMCR Wiki</div>
          <SearchInputView size="md" value={query} onChange={setQuery} placeholder="Search the wiki" prefix={<SearchIcon size={13} />} />
          <div className="wk-nav-list">
            {groups.map(g => (
              <div key={g.name} className="wk-nav-group">
                <div className="wk-nav-group-name">{g.name}</div>
                {g.pages.map(p => (
                  <button key={p.id} type="button" className={`wk-nav-item${p.id === page.id ? ' is-active' : ''}`} onClick={() => setPageId(p.id)}>
                    {p.title}
                    {words.length > 0 && <span className="wk-nav-item-group">{p.group}</span>}
                  </button>
                ))}
              </div>
            ))}
            {!shown.length && <div className="wk-nav-none">Nothing matches “{query}”.</div>}
          </div>
        </nav>
      )}
      <article className="wk-page" ref={bodyRef} onClick={onLinkClick}>
        <div className="wk-page-group">{page.group}</div>
        <h1 className="wk-page-title">{page.title}</h1>
        <MarkdownView className="wk-md" content={page.body} />
        <div className="wk-pager">
          {prev ? <button type="button" className="wk-pager-btn" onClick={() => setPageId(prev.id)}><ChevronLeftIcon size={14} /><span><small>Previous</small>{prev.title}</span></button> : <span />}
          {next ? <button type="button" className="wk-pager-btn wk-pager-btn--next" onClick={() => setPageId(next.id)}><span><small>Next</small>{next.title}</span><ChevronRightIcon size={14} /></button> : <span />}
        </div>
      </article>
    </div>
  );
}
