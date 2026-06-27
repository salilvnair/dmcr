/**
 * Lightweight local RAG for DmcrWiki.md
 *
 * Algorithm: BM25-lite
 *   - Parse wiki markdown into sections (split on ## headings)
 *   - Tokenise each section + query into unigrams & bigrams
 *   - Score every section with BM25 (k1=1.5, b=0.75)
 *   - Return the top-k sections concatenated as a context string
 *
 * No external dependencies — pure TypeScript, runs in the extension host.
 */

import * as fs   from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WikiSection {
  heading : string;   // the ## heading text
  level   : number;   // 1 = #, 2 = ##, 3 = ###
  body    : string;   // raw markdown content (excluding the heading line)
  tokens  : string[]; // pre-computed unigrams + bigrams
}

// ─── Tokeniser ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a','an','the','is','it','in','on','of','to','for','and','or','but','not',
  'be','are','was','were','has','have','had','do','does','did','with','at',
  'by','from','this','that','these','those','as','if','so','will','can','may',
  'all','any','how','what','when','where','which','who','why','your','you',
  'i','me','my','we','our','they','their','he','she','its',
]);

function tokenise(text: string): string[] {
  const raw = text
    .toLowerCase()
    // strip markdown syntax characters
    .replace(/[`*_#\[\]|]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9_-]+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));

  // unigrams + bigrams
  const tokens: string[] = [...raw];
  for (let i = 0; i < raw.length - 1; i++) {
    tokens.push(`${raw[i]}_${raw[i + 1]}`);
  }
  return tokens;
}

// ─── Wiki parser ──────────────────────────────────────────────────────────────

export function parseWikiSections(markdown: string): WikiSection[] {
  const lines    = markdown.split('\n');
  const sections : WikiSection[] = [];
  let heading    = '(introduction)';
  let level      = 1;
  let bodyLines  : string[] = [];

  const flush = () => {
    const body = bodyLines.join('\n').trim();
    if (body || sections.length === 0) {
      sections.push({ heading, level, body, tokens: tokenise(heading + ' ' + body) });
    }
    bodyLines = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.+)$/);
    if (m) {
      flush();
      level   = m[1].length;
      heading = m[2].trim();
    } else {
      bodyLines.push(line);
    }
  }
  flush();
  return sections;
}

// ─── BM25 scorer ─────────────────────────────────────────────────────────────

const K1 = 1.5;
const B  = 0.75;

function bm25Score(
  queryTokens : string[],
  section     : WikiSection,
  avgDocLen   : number,
  idfMap      : Map<string, number>,
): number {
  const tf: Map<string, number> = new Map();
  for (const t of section.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  const docLen = section.tokens.length;
  let score = 0;
  for (const qt of queryTokens) {
    const idf = idfMap.get(qt) ?? 0;
    if (idf === 0) continue;
    const f  = tf.get(qt) ?? 0;
    const numerator   = f * (K1 + 1);
    const denominator = f + K1 * (1 - B + B * (docLen / avgDocLen));
    score += idf * (numerator / denominator);
  }
  return score;
}

function buildIdfMap(queryTokens: string[], sections: WikiSection[]): Map<string, number> {
  const N   = sections.length;
  const df  = new Map<string, number>();
  for (const qt of queryTokens) {
    let count = 0;
    for (const s of sections) {
      if (s.tokens.includes(qt)) count++;
    }
    df.set(qt, count);
  }
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    // Robertson-Sparck Jones IDF (clamped to 0)
    idf.set(term, Math.max(0, Math.log((N - freq + 0.5) / (freq + 0.5) + 1)));
  }
  return idf;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search the wiki for sections relevant to `query` and return them as a
 * formatted markdown string ready to be injected into an LLM system prompt.
 *
 * @param query         The user's question / message
 * @param extensionPath The resolved `context.extensionPath` from DmcrPanel
 * @param topK          Maximum number of sections to return (default 4)
 * @returns             Formatted context string, or empty string if wiki missing
 */
export function searchWiki(query: string, extensionPath: string, topK = 4): string {
  // DmcrWiki.md is bundled into dist/ alongside extension.js
  const wikiPath = path.join(extensionPath, 'dist', 'DmcrWiki.md');
  // Fallback: source location (dev / test without build)
  const wikiPathDev = path.join(extensionPath, 'src', 'forms', 'llm', 'prompts', 'DmcrWiki.md');

  let markdown = '';
  try {
    markdown = fs.readFileSync(wikiPath, 'utf8');
  } catch {
    try {
      markdown = fs.readFileSync(wikiPathDev, 'utf8');
    } catch {
      return '';
    }
  }

  const sections    = parseWikiSections(markdown);
  const queryTokens = tokenise(query);

  if (queryTokens.length === 0 || sections.length === 0) {
    // No useful tokens — return the first two sections as generic context
    return sections
      .slice(0, 2)
      .map(s => `### ${s.heading}\n${s.body}`)
      .join('\n\n---\n\n');
  }

  const avgDocLen = sections.reduce((s, sec) => s + sec.tokens.length, 0) / sections.length;
  const idfMap    = buildIdfMap(queryTokens, sections);

  const scored = sections
    .map(sec => ({ sec, score: bm25Score(queryTokens, sec, avgDocLen, idfMap) }))
    .sort((a, b) => b.score - a.score);

  // Always include at least 1 section even if score is 0
  const picked = scored.slice(0, topK).filter((_, i) => i === 0 || _.score > 0);

  return picked
    .map(({ sec }) => `### ${sec.heading}\n${sec.body}`)
    .join('\n\n---\n\n');
}

/**
 * Load and return the full wiki text (for cases where you want to pass
 * the entire document, e.g. for very short wikis).
 */
export function loadFullWiki(): string {
  const wikiPath = path.join(__dirname, '..', 'forms', 'llm', 'prompts', 'DmcrWiki.md');
  try {
    return fs.readFileSync(wikiPath, 'utf8');
  } catch {
    return '';
  }
}
