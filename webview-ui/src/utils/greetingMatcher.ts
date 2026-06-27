/**
 * greetingMatcher.ts
 *
 * Matches common social phrases (greetings, farewells, thanks, etc.) against
 * the local greetings.json catalogue and returns a random canned reply.
 *
 * Returns null when the message is NOT a social phrase, so callers can fall
 * through to the AI for real database questions.
 *
 * To add new phrases or replies, edit: src/data/greetings.json
 */
import greetingsData from '../data/greetings.json';

interface GreetingCategory {
  id: string;
  patterns: string[];
  replies: string[];
}

interface GreetingsFile {
  categories: GreetingCategory[];
  _comment?: string;
}

const data = greetingsData as GreetingsFile;

/** Normalise a message for matching: lowercase, trim, strip trailing punctuation */
function normalise(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[!?.,']+$/, '')
    .trim();
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Returns a canned reply string when the message is a recognised social phrase,
 * otherwise returns null.
 *
 * Matching rules (checked in order):
 *  1. Exact match after normalisation
 *  2. Normalised message *starts with* a pattern (covers "hi there!", "thanks a lot", etc.)
 *     — only applied when the message is short (≤ 60 chars) to avoid false positives
 */
export function matchGreeting(message: string): string | null {
  const norm = normalise(message);
  if (!norm) return null;

  for (const cat of data.categories) {
    const patterns = cat.patterns;

    // 1 — exact match
    if (patterns.some(p => p.toLowerCase() === norm)) {
      return pickRandom(cat.replies);
    }

    // 2 — prefix match for short messages
    if (norm.length <= 60) {
      const hit = patterns.some(p => {
        const pl = p.toLowerCase();
        return (
          norm === pl ||
          norm.startsWith(pl + ' ') ||
          norm.startsWith(pl + ',') ||
          norm.startsWith(pl + '!')
        );
      });
      if (hit) return pickRandom(cat.replies);
    }
  }

  return null;
}
