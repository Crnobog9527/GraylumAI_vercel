/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { syncModuleVersion } from './module-version-sync';

type Module = { id: string; updated_at: string; name: string };

function harness(start: Module | null) {
  let editing = start;
  const set = (update: (current: Module | null) => Module | null) => { editing = update(editing); };
  return { set, get: () => editing };
}

it('copies only the new version into the module being edited, keeping unsaved fields', async () => {
  const h = harness({ id: 'm1', updated_at: 'old', name: '未保存的名称' });
  const ok = await syncModuleVersion<Module>(async () => ({ data: { modules: [{ id: 'm1', updated_at: 'new' }] } }), 'm1', h.set);
  expect(ok).toBe(true);
  expect(h.get()).toEqual({ id: 'm1', updated_at: 'new', name: '未保存的名称' });
});

it('reports failure when the module is missing or the read fails, and never touches another module', async () => {
  const h = harness({ id: 'm2', updated_at: 'old', name: 'x' });
  expect(await syncModuleVersion<Module>(async () => ({ data: { modules: [] } }), 'm2', h.set)).toBe(false);
  expect(await syncModuleVersion<Module>(async () => { throw new Error('offline'); }, 'm2', h.set)).toBe(false);
  expect(await syncModuleVersion<Module>(async () => ({ data: { modules: [{ id: 'm1', updated_at: 'new' }] } }), 'm1', h.set)).toBe(true);
  expect(h.get()).toEqual({ id: 'm2', updated_at: 'old', name: 'x' });
  expect(await syncModuleVersion<Module>(async () => ({ data: undefined }), undefined, h.set)).toBe(false);
});
