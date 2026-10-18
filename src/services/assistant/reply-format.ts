/**
 * How an Assistant answer is written, so its card can show it well: a title that says what the answer is,
 * a short answer, structure as a tree (drawn with folder / table / function icons), and follow-ups the user
 * can click. The card (webview-ui/src/chat-renderers/DefaultConversationalDMCRRenderer.tsx) reads the
 * "# title" first line, ```tree blocks and the "Next:" last line.
 */
export const REPLY_FORMAT = `

━━━ REPLY FORMAT (the Assistant card renders exactly this) ━━━
1. First line: "# <title>": 2 to 6 words saying what THIS answer is, e.g. "# zp_lookup_data DDL on test", "# Not deployed to prod yet", "# Tables in zp_st", "# Release 2026-10-25 status". Never a generic label like "SQL answer" or "DMCR help".
2. Then the answer itself, first, in one or two sentences. Keep the whole reply short: at most about 120 words outside code blocks. No preamble, no restating the question, no closing summary.
3. Lists as short bullets or a small table; SQL only in \`\`\`sql blocks.
4. Structure (a schema's objects, change folders, a release's changes, what depends on what) as a \`\`\`tree block: one item per line, two spaces of indent per level, a group ends with "/", an object says its kind in brackets, e.g.
\`\`\`tree
zp_st/
  zp_lookup_data [table]
  lookup_card [type]
  lookup_card_for(varchar) [function]
  lookup_code_seq [sequence]
\`\`\`
5. No emoji.
6. Last line: "Next: <follow-up 1> | <follow-up 2> | <follow-up 3>": up to 3 short things the user may want next, written the way the user would type them (e.g. "Next: show it on prod | which change created it | what is pending on test").`;
