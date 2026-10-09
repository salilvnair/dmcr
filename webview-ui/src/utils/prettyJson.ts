/** meta.json as the AI returned it, indented for reading (left as-is when it is not valid JSON). */
export function prettyJson(text: string | undefined): string | undefined {
  if (!text) return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
