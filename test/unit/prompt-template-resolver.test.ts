import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolvePromptTemplate } from '../../src/services/llm/template/prompt-template-resolver';

test('substitutes {{vars}} and leaves unknown ones', () => {
  assert.equal(resolvePromptTemplate('Hi {{name}}, {{other}}', { name: 'Ann' }), 'Hi Ann, {{other}}');
});

test('blankIfUnset turns declared-but-missing variables into empty text', () => {
  const out = resolvePromptTemplate('A{{hint}}B {{other}}', {}, { blankIfUnset: ['hint'] });
  assert.equal(out, 'AB {{other}}');
});

test('{{#if}} picks the set branch, {{else}} the unset branch', () => {
  const t = '{{#if hint}}Use "{{hint}}".{{else}}Pick a name.{{/if}}';
  assert.equal(resolvePromptTemplate(t, { hint: 'add_col' }), 'Use "add_col".');
  assert.equal(resolvePromptTemplate(t, {}), 'Pick a name.');
  assert.equal(resolvePromptTemplate(t, { hint: '   ' }), 'Pick a name.'); // blank counts as unset
});

test('{{#if}} without {{else}} and nested blocks', () => {
  assert.equal(resolvePromptTemplate('[{{#if a}}A{{/if}}]', {}), '[]');
  const nested = '{{#if a}}a{{#if b}}b{{else}}-{{/if}}{{/if}}';
  assert.equal(resolvePromptTemplate(nested, { a: '1', b: '1' }), 'ab');
  assert.equal(resolvePromptTemplate(nested, { a: '1' }), 'a-');
  assert.equal(resolvePromptTemplate(nested, { b: '1' }), '');
});

test('function-style variables use their resolver', () => {
  const out = resolvePromptTemplate("{{pool['X', 'Y']}}", {}, { functionResolvers: { pool: args => args.join('+') } });
  assert.equal(out, 'X+Y');
});
