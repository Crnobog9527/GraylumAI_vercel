/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureMaintenanceDisabled } from '../ensure-preview-ready.mjs';

for (const state of ['checked', null, 'unexpected']) {
  test(`maintenance state ${state} stops without touching any control`, async () => {
    const calls = [];
    const page = { getByTestId(id) {
      calls.push(id);
      return { waitFor: async () => {}, getAttribute: async () => state };
    } };
    await assert.rejects(ensureMaintenanceDisabled(page), /preflight stopped without changing settings/);
    assert.deepEqual(calls, ['admin-setting-maintenance_mode']);
  });
}
test('disabled maintenance continues without changing any control', async () => {
  const calls = [];
  await ensureMaintenanceDisabled({ getByTestId(id) {
    calls.push(id);
    return { waitFor: async () => {}, getAttribute: async () => 'unchecked' };
  } });
  assert.deepEqual(calls, ['admin-setting-maintenance_mode']);
});
