#!/usr/bin/env node
// Fix mojibake (Windows-1252-misread UTF-8) in webview source files
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'webview-ui', 'src');
const files = [
  path.join(root, 'App.tsx'),
  path.join(root, 'pages', 'HomePage.tsx'),
];

function fix(t) {
  // Remove BOM
  t = t.replace(/^\uFEFF/, '');
  // â€" = em-dash mojibake (U+00E2 U+20AC U+201D)
  t = t.replace(/\u00e2\u20ac\u201d/g, ' - ');
  // â€¦ = ellipsis mojibake (U+00E2 U+20AC U+00A6)
  t = t.replace(/\u00e2\u20ac\u00a6/g, '...');
  // â†' = right-arrow mojibake (U+00E2 U+2020 U+2019)
  t = t.replace(/\u00e2\u2020\u2019/g, '->');
  // â"€ = box-draw-dash mojibake (U+00E2 U+201D U+20AC)
  t = t.replace(/\u00e2\u201d\u20ac/g, '-');
  // â"‚ = box-draw-pipe mojibake (U+00E2 U+201D U+201A)
  t = t.replace(/\u00e2\u201d\u201a/g, '|');
  // âš  = warning-sign mojibake (U+00E2 U+0161 U+00A0)
  t = t.replace(/\u00e2\u0161\u00a0/g, '[!]');
  // âœ" = check-mark mojibake (U+00E2 U+0153 U+201C)
  t = t.replace(/\u00e2\u0153\u201c/g, 'OK ');
  // Â· = middle-dot mojibake (U+00C2 U+00B7)
  t = t.replace(/\u00c2\u00b7/g, '·');
  // â€™ = right-single-quote mojibake (U+00E2 U+20AC U+2122)
  t = t.replace(/\u00e2\u20ac\u2122/g, "'");
  // â€˜ = left-single-quote mojibake (U+00E2 U+20AC U+02DC)
  t = t.replace(/\u00e2\u20ac\u02dc/g, "'");
  // â€œ = left-double-quote mojibake (U+00E2 U+20AC U+0153)
  t = t.replace(/\u00e2\u20ac\u0153/g, '"');
  return t;
}

for (const f of files) {
  if (!fs.existsSync(f)) { console.log('SKIP (not found):', f); continue; }
  const orig = fs.readFileSync(f, 'utf8');
  const fixed = fix(orig);
  const remaining = [...fixed].filter(c => c.charCodeAt(0) > 127).length;
  if (orig !== fixed) {
    fs.writeFileSync(f, fixed, 'utf8');
    console.log('FIXED:', path.basename(f), '| remaining non-ascii:', remaining);
  } else {
    console.log('CLEAN:', path.basename(f), '| remaining non-ascii:', remaining);
  }
}
