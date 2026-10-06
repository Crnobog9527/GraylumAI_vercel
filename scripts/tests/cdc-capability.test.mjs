/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { profiles, variant, reserveNano } from '../cdc-b2-eval/capabilitySource.mjs';
import { canReserve, settlementNano } from '../cdc-b2-eval/reasoningSource.mjs';
const original = { model: 'openai/gpt-6-luna', messages: [{ role: 'system', content: '冻结提示词' },
  { role: 'user', content: '冻结输入' }], max_tokens: 2048, stream: false, store: false,
provider: { allow_fallbacks: false, require_parameters: true, only: ['openai'],
  max_price: { prompt: 0.25, completion: 0.75, request: 0 } } };

test('only authorized model, route, and corresponding price ceiling change', () => {
  for (const name of Object.keys(profiles)) {
    const result = JSON.parse(variant(JSON.stringify(original), name));
    assert.equal(result.model, profiles[name].model);
    assert.deepEqual(result.provider.only, [profiles[name].tag]);
    assert.equal(result.reasoning, undefined);
    assert.equal(result.reasoning_effort, undefined);
    result.model = original.model;
    result.provider.only = original.provider.only;
    result.provider.max_price = original.provider.max_price;
    assert.deepEqual(result, original);
  }
});
test('reject changed baseline, unknown model, and excessive input', () => {
  assert.throws(() => variant(JSON.stringify({ ...original, max_tokens: 4096 }), 'sonnet'));
  assert.throws(() => variant(JSON.stringify({ ...original, reasoning: {} }), 'sonnet'));
  assert.throws(() => variant(JSON.stringify(original), 'other'));
  assert.throws(() => variant(JSON.stringify({ ...original, messages: ['字'.repeat(64000)] }), 'gemini'));
});
test('reserve uses UTF8 bytes, cache-write ceiling, full output and exact budget edge', () => {
  const raw = variant(JSON.stringify(original), 'sonnet');
  const reserve = reserveNano(raw, 'sonnet');
  assert.equal(reserve, (Buffer.byteLength(raw) + 8192) * 4000 + 2048 * 10000);
  assert.equal(canReserve(1e9 - reserve, 0, reserve), true);
  assert.equal(canReserve(1e9 - reserve + 1, 0, reserve), false);
  assert.equal(canReserve(0, 1, reserve), false);
  assert.throws(() => settlementNano(undefined, reserve));
  assert.throws(() => settlementNano(reserve / 1e9 + 0.0001, reserve));
});
