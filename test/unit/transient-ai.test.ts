import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isTransientAiError } from '../../src/services/llm/core/transient';

const withCause = (msg: string, cause: unknown) => Object.assign(new TypeError(msg), { cause });

test('a connection dropped mid-answer is tried again', () => {
  assert.equal(isTransientAiError(withCause('terminated', Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }))), true);
  assert.equal(isTransientAiError(withCause('fetch failed', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))), true);
});

test('a busy or failing provider (429, 5xx) is tried again', () => {
  assert.equal(isTransientAiError(new Error('[openai-adapter] stream failed 503: overloaded')), true);
  assert.equal(isTransientAiError(new Error('[anthropic-adapter] chat failed 429: rate limited')), true);
});

test('a bad request, a wrong key or the no-answer timeout is not', () => {
  assert.equal(isTransientAiError(new Error('[openai-adapter] stream failed 401: invalid key')), false);
  assert.equal(isTransientAiError(new Error('[openai-adapter] chat failed 400: bad model')), false);
  assert.equal(isTransientAiError(new Error('DeepSeek (deepseek-flash) sent no answer for 90 s; the provider may be overloaded or down.')), false);
  assert.equal(isTransientAiError(undefined), false);
});
