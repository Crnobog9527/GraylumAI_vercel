/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, profiles, checkCases } from '../cdc-writeback-v2/source.mjs';
function raw(role, patch = {}) {
  const p = profiles[role];
  return JSON.stringify({ model: p.model, max_tokens: p.output, store: false, stream: role === 'mentor',
    ...(role === 'mentor' ? { reasoning_effort: 'low' } : {}),
    provider: { allow_fallbacks: false, require_parameters: true, only: [p.tag],
      max_price: { prompt: p.prompt, completion: p.completion, request: 0 } }, ...patch });
}
test('same profiles and conservative reservation cover full output without cache discounts', () => {
  for (const role of ['mentor', 'organizer']) {
    const request = raw(role), p = profiles[role];
    assert.equal(measure(request, role).reserveNano,
      Math.ceil((Buffer.byteLength(request) + 8192) * p.prompt * 1000 + p.output * p.completion * 1000));
  }
});
test('reasoning, route, output cap, and input limit changes are refused', () => {
  for (const patch of [{ reasoning_effort: 'low' }, { reasoning: {} }, { max_tokens: 2049 },
    { provider: {} }, { model: 'another' }, { store: true }, { messages: ['a'.repeat(64000)] }]) {
    assert.throws(() => measure(raw('organizer', patch), 'organizer'));
  }
  assert.throws(() => measure(raw('mentor', { reasoning_effort: 'medium' }), 'mentor'));
});
test('unknown field identifiers and incomplete gold cannot freeze', () => {
  const flow = { steps: [{ information: [{ id: 'goal' }] }] };
  const cases = Array.from({ length: 100 }, (_, i) => ({ id: `C${String(i + 1).padStart(3, '0')}`,
    stepId: 'step-1', questionId: 'goal', input: 'Synthetic request', initial: [], gold: [],
    forbiddenEverywhere: [], expectNoUserFactChange: true }));
  checkCases(cases, flow);
  cases[0].initial.push({ stepId: 'step-1', fieldId: 'old-field' });
  assert.throws(() => checkCases(cases, flow), /CASE_FIELD/);
});
