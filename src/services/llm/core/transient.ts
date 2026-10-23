/**
 * A failure worth one more try: the connection dropped mid-answer (Node's fetch says "terminated", or
 * "fetch failed" with a socket error under it) or the provider answered 429 / 5xx. Not a 4xx or the
 * no-answer timeout, which would only fail the same way again.
 */
export function isTransientAiError(e: unknown): boolean {
  const texts: string[] = [];
  for (let c: unknown = e, i = 0; c && i < 4; c = (c as { cause?: unknown }).cause, i++) {
    texts.push(String((c as { message?: unknown }).message ?? c), String((c as { code?: unknown }).code ?? ''));
  }
  const t = texts.join(' ');
  if (/sent no answer for/.test(t)) return false;
  return /\bterminated\b|other side closed|socket hang up|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_SOCKET/i.test(t)
    || /\b(?:chat|stream) failed (?:429|5\d\d)\b/.test(t);
}
