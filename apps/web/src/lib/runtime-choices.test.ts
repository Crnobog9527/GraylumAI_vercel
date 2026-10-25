/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { mutationAffectsRuntimeChoices, RUNTIME_CHOICES_STALE_MS } from './runtime-choices';

it('keeps runtime.choices for minutes, not seconds', () => {
  expect(RUNTIME_CHOICES_STALE_MS).toBe(300_000);
});

it.each([
  [[['settings', 'updateSystemSettingsBulk']], true],
  [[['model', 'updateModel']], true],
  [[['modelIdentity', 'set']], true],
  [[['skills', 'publish']], true],
  [[['runtime', 'execute']], false],
  [[['credits', 'getBalance']], false],
  [undefined, false],
  [[], false],
  [['settings'], false],
])('mutation key %j invalidates choices: %s', (key, expected) => {
  expect(mutationAffectsRuntimeChoices(key)).toBe(expected);
});
