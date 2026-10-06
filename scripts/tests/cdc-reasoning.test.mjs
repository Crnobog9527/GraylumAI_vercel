/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variant, reserveNano, canReserve, settlementNano } from '../cdc-b2-eval/reasoningSource.mjs';

const body = { model: 'openai/gpt-6-luna', messages: [{ role: 'user', content: '合成试验数据' }],
  max_tokens: 2048, stream: false, store: false,
  provider: { allow_fallbacks: false, require_parameters: true, only: ['openai'],
    max_price: { prompt: 0.25, completion: 0.75, request: 0 } } };
test('only the explicit effort changes; all frozen request fields survive', () => {
  for (const effort of ['low', 'medium', 'high']) {
    const changed = JSON.parse(variant(JSON.stringify(body), effort));
    assert.equal(changed.reasoning_effort, effort);
    delete changed.reasoning_effort;
    assert.deepEqual(changed, body);
  }
});
test('refuses changed route, existing effort, output cap, input cap and unapproved effort', () => {
  for (const change of [{ provider: { only: ['openai'] } }, { reasoning_effort: 'none' },
    { reasoning: { effort: 'none' } }, { max_tokens: 4096 }, { store: true }, { model: 'another-model' },
    { messages: [{ content: 'x'.repeat(64000) }] }]) {
    assert.throws(() => variant(JSON.stringify({ ...body, ...change }), 'low'));
  }
  assert.throws(() => variant(JSON.stringify(body), 'max'));
});
test('input reservation counts UTF-8 bytes and full reasoning plus visible output cap', () => {
  const raw = variant(JSON.stringify(body), 'medium');
  assert.equal(reserveNano(raw), (Buffer.byteLength(raw) + 8192) * 250 + 2048 * 750);
});
test('one-dollar boundary permits exact fit but refuses overflow and outstanding unknown cost', () => {
  assert.equal(canReserve(999999000, 0, 1000), true);
  assert.equal(canReserve(999999001, 0, 1000), false);
  assert.equal(canReserve(0, 1, 1000), false);
  for (const bad of [-1, 0.5, NaN, Infinity]) assert.equal(canReserve(bad, 0, 1000), false);
});
test('unknown or over-reservation cost cannot release the reservation; fractions round up', () => {
  for (const cost of [undefined, null, '0', NaN, Infinity, -1]) assert.throws(() => settlementNano(cost, 100));
  assert.throws(() => settlementNano(0.001, 999999));
  assert.equal(settlementNano(0.0000000011, 100), 2);
});
