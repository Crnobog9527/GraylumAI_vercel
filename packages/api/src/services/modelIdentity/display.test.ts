/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { FUSION_REVIEW_SURFACE, modelAlias, publicModelChoices } from './display';

const models = [
  { id: 'a1', name: 'claude-sonnet-5.5', model_id: 'anthropic/claude-sonnet-5.5', provider: 'anthropic' },
  { id: 'b2', name: 'Gemini 3.8 Flash', model_id: 'google/gemini-3.8-flash', provider: 'google' },
];

it('only opaque ids and A/B labels leave the server', () => {
  const result = publicModelChoices(models, { surface: 'user' });
  expect(result).toEqual([{ id: 'a1', label: '模型 A' }, { id: 'b2', label: '模型 B' }]);
  expect(JSON.stringify(result)).not.toMatch(/claude|gemini|anthropic|google/i);
});

it('the response type has no switch input: real names never reach users outside Fusion (review P1)', () => {
  // @ts-expect-error the guard switch must not influence server-browser data
  publicModelChoices(models, { guardEnabled: false, surface: 'user' });
  expect(JSON.stringify(publicModelChoices(models, { surface: 'user' }))).not.toMatch(/claude|gemini/i);
});

it('Fusion review is the explicit whitelist and shows real names', () => {
  expect(publicModelChoices(models, { surface: FUSION_REVIEW_SURFACE }).map(m => m.label))
    .toEqual(['claude-sonnet-5.5', 'Gemini 3.8 Flash']);
});

it('aliases beyond Z stay unique', () => {
  expect(modelAlias(0)).toBe('模型 A');
  expect(modelAlias(25)).toBe('模型 Z');
  expect(modelAlias(26)).toBe('模型 27');
});
