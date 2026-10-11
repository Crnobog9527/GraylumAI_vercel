/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { FUSION_REVIEW_SURFACE, modelAlias, publicModelChoices } from './display';

const models = [
  { id: 'a1', name: 'claude-sonnet-5.5', model_id: 'anthropic/claude-sonnet-5.5', provider: 'anthropic' },
  { id: 'b2', name: 'Gemini 3.8 Flash', model_id: 'google/gemini-3.8-flash', provider: 'google' },
];

it('switch on: only opaque ids and A/B labels leave the server', () => {
  const result = publicModelChoices(models, { guardEnabled: true, surface: 'user' });
  expect(result).toEqual([{ id: 'a1', label: '模型 A' }, { id: 'b2', label: '模型 B' }]);
  expect(JSON.stringify(result)).not.toMatch(/claude|gemini|anthropic|google/i);
});

it('switch off: label is the admin-entered name, technical id and provider still omitted', () => {
  const result = publicModelChoices(models, { guardEnabled: false, surface: 'user' });
  expect(result).toEqual([{ id: 'a1', label: 'claude-sonnet-5.5' }, { id: 'b2', label: 'Gemini 3.8 Flash' }]);
  expect(JSON.stringify(result)).not.toMatch(/anthropic\/|google\/|"provider"|model_id/);
});

it('Fusion review is the explicit whitelist and shows real names even when the switch is on', () => {
  expect(publicModelChoices(models, { guardEnabled: true, surface: FUSION_REVIEW_SURFACE }).map(m => m.label))
    .toEqual(['claude-sonnet-5.5', 'Gemini 3.8 Flash']);
});

it('aliases beyond Z stay unique', () => {
  expect(modelAlias(0)).toBe('模型 A');
  expect(modelAlias(25)).toBe('模型 Z');
  expect(modelAlias(26)).toBe('模型 27');
});
