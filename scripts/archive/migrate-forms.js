/**
 * migrate-forms.js
 * Reorganises src/ files into src/forms/{llm,core,utils} with updated imports.
 * Run from the workspace root: node scripts/migrate-forms.js
 */
const fs   = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, '..', 'src');

// ── 1. Create target directories ──────────────────────────────────────────────
const DIRS = [
  'forms/llm/chat',
  'forms/llm/generation',
  'forms/llm/prompts',
  'forms/core/types',
  'forms/core/panels',
  'forms/utils',
];
for (const d of DIRS) {
  fs.mkdirSync(path.join(SRC, d), { recursive: true });
}
console.log('Directories created.');

// ── 2. Move table ─────────────────────────────────────────────────────────────
//  [oldRelative, newRelative, { oldImport: newImport, ... }]
const MOVES = [
  // ── LLM / chat (orchestrator) ──────────────────────────────────────────────
  [
    'dmcr-chat-handler.ts',
    'forms/llm/chat/chat-handler.ts',
    {
      '"./dmcr-generator"'        : '"../generation/generator"',
      '"./dmcr-intent-detector"'  : '"../generation/intent-detector"',
      '"./dmcr-followups"'        : '"../../core/types/followups"',
      '"./dmcr-request-planner"'  : '"../generation/request-planner"',
      '"./dmcr-followup-decider"' : '"../generation/followup-decider"',
      '"./dmcr-intent"'           : '"../../core/types/intent"',
      '"./dmcr-add-columns-form"' : '"../../core/panels/add-columns-form"',
      '"./dmcr-insert-rows-form"' : '"../../core/panels/insert-rows-form"',
      '"./bootstrap-form"'        : '"../../core/panels/bootstrap-form"',
      '"./dmcr-freeform-sql-form"': '"../../core/panels/freeform-sql-form"',
    },
  ],
  // ── LLM / generation ──────────────────────────────────────────────────────
  [
    'dmcr-generator.ts',
    'forms/llm/generation/generator.ts',
    { '"./prompt_template"': '"../prompts/prompt-template"' },
  ],
  [
    'dmcr-intent-detector.ts',
    'forms/llm/generation/intent-detector.ts',
    {
      '"./dmcr-intent"'   : '"../../core/types/intent"',
      '"./prompt_template"': '"../prompts/prompt-template"',
    },
  ],
  [
    'dmcr-request-planner.ts',
    'forms/llm/generation/request-planner.ts',
    { '"./prompt_template"': '"../prompts/prompt-template"' },
  ],
  [
    'dmcr-followup-decider.ts',
    'forms/llm/generation/followup-decider.ts',
    {
      '"./dmcr-followups"' : '"../../core/types/followups"',
      '"./dmcr-intent"'    : '"../../core/types/intent"',
      '"./prompt_template"': '"../prompts/prompt-template"',
    },
  ],
  // ── LLM / prompts ─────────────────────────────────────────────────────────
  [
    'prompt_template.ts',
    'forms/llm/prompts/prompt-template.ts',
    {},
  ],
  // ── Core / types ──────────────────────────────────────────────────────────
  [
    'dmcr-intent.ts',
    'forms/core/types/intent.ts',
    {},
  ],
  [
    'dmcr-followups.ts',
    'forms/core/types/followups.ts',
    { '"./dmcr-intent"': '"./intent"' },
  ],
  // ── Core / panels ─────────────────────────────────────────────────────────
  [
    'dmcr-add-columns-form.ts',
    'forms/core/panels/add-columns-form.ts',
    { '"./prompt_template"': '"../../llm/prompts/prompt-template"' },
  ],
  [
    'dmcr-insert-rows-form.ts',
    'forms/core/panels/insert-rows-form.ts',
    { '"./prompt_template"': '"../../llm/prompts/prompt-template"' },
  ],
  [
    'dmcr-freeform-sql-form.ts',
    'forms/core/panels/freeform-sql-form.ts',
    {
      '"./dmcr-sql-utils"' : '"../../utils/sql-utils"',
      '"./prompt_template"': '"../../llm/prompts/prompt-template"',
    },
  ],
  [
    'bootstrap-form.ts',
    'forms/core/panels/bootstrap-form.ts',
    {},
  ],
  // ── Utils ─────────────────────────────────────────────────────────────────
  [
    'dmcr-sql-utils.ts',
    'forms/utils/sql-utils.ts',
    {},
  ],
  [
    'dmcr-db-introspector.ts',
    'forms/utils/db-introspector.ts',
    {},
  ],
];

// ── 3. Read, patch imports, write new file, delete old ───────────────────────
for (const [oldRel, newRel, importMap] of MOVES) {
  const oldPath = path.join(SRC, oldRel);
  const newPath = path.join(SRC, newRel);

  let content = fs.readFileSync(oldPath, 'utf8');

  for (const [oldImp, newImp] of Object.entries(importMap)) {
    // Replace all occurrences (could appear in re-exports too)
    const re = new RegExp(oldImp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    content = content.replace(re, newImp);
  }

  fs.writeFileSync(newPath, content, 'utf8');
  fs.unlinkSync(oldPath);
  console.log(`  moved  ${oldRel}  →  ${newRel}`);
}

// ── 4. Patch external files that import the moved modules ────────────────────
const EXTERNAL_PATCHES = [
  // src/extension.ts
  {
    file: path.join(SRC, 'extension.ts'),
    replacements: {
      '"./dmcr-chat-handler"': '"./forms/llm/chat/chat-handler"',
    },
  },
  // src/panel/DmcrPanel.ts
  {
    file: path.join(SRC, 'panel', 'DmcrPanel.ts'),
    replacements: {
      '"../dmcr-add-columns-form"' : '"../forms/core/panels/add-columns-form"',
      '"../dmcr-insert-rows-form"' : '"../forms/core/panels/insert-rows-form"',
      '"../dmcr-freeform-sql-form"': '"../forms/core/panels/freeform-sql-form"',
      '"../dmcr-generator"'        : '"../forms/llm/generation/generator"',
      '"../prompt_template"'       : '"../forms/llm/prompts/prompt-template"',
    },
  },
];

for (const { file, replacements } of EXTERNAL_PATCHES) {
  if (!fs.existsSync(file)) {
    console.warn(`  WARN: ${file} not found, skipping.`);
    continue;
  }
  let content = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const [oldImp, newImp] of Object.entries(replacements)) {
    const re = new RegExp(oldImp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const next = content.replace(re, newImp);
    if (next !== content) { content = next; changed = true; }
  }
  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
    console.log(`  patched  ${path.relative(SRC, file)}`);
  } else {
    console.log(`  (no change needed)  ${path.relative(SRC, file)}`);
  }
}

console.log('\nForm sync complete.');
