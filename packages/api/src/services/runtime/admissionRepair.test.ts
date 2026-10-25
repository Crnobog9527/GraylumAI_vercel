/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { admitWithRepair, keepsCause, sessionBusy } from './admissionRepair';

const admin = {} as SupabaseClient;
const busy = () => new Error('RUNTIME_ADMISSION_DENIED', { cause: { code: 'P0001', message: 'RUNTIME_SESSION_BUSY' } });

it('recognises only the session-busy refusal of runtime_admit', () => {
  expect(sessionBusy(busy())).toBe(true);
  expect(sessionBusy(new Error('RUNTIME_ADMISSION_DENIED'))).toBe(false);
  expect(sessionBusy(new Error('RUNTIME_ADMISSION_DENIED', { cause: { message: 'RUNTIME_SCOPE_DENIED' } }))).toBe(false);
  expect(keepsCause('runtime_admit', 'RUNTIME_SESSION_BUSY')).toBe(true);
  expect(keepsCause('runtime_material', 'RUNTIME_SESSION_BUSY')).toBe(false);
  expect(keepsCause('runtime_admit', 'RUNTIME_SCOPE_DENIED')).toBe(false);
});

it('a blocked message is admitted once the earlier round is repaired', async () => {
  const admit = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce({ executionId: 'e' });
  const repair = vi.fn(async () => true);
  expect(await admitWithRepair(admin, 'actor', admit, repair)).toEqual({ executionId: 'e' });
  expect(repair).toHaveBeenCalledExactlyOnceWith(admin, 'actor');
  expect(admit).toHaveBeenCalledTimes(2);
});

it('keeps the original refusal when nothing was repaired (timeout or a round still running)', async () => {
  const refusal = busy();
  const admit = vi.fn().mockRejectedValue(refusal);
  const repair = vi.fn(async () => false);
  await expect(admitWithRepair(admin, 'actor', admit, repair)).rejects.toBe(refusal);
  expect(admit).toHaveBeenCalledTimes(1);
});

it('retries only once: a second refusal stands', async () => {
  const admit = vi.fn().mockRejectedValue(busy());
  const repair = vi.fn(async () => true);
  await expect(admitWithRepair(admin, 'actor', admit, repair)).rejects.toMatchObject({ message: 'RUNTIME_ADMISSION_DENIED' });
  expect(admit).toHaveBeenCalledTimes(2);
  expect(repair).toHaveBeenCalledTimes(1);
});

it('never repairs for any other refusal', async () => {
  const other = new Error('RUNTIME_ADMISSION_DENIED');
  const repair = vi.fn(async () => true);
  await expect(admitWithRepair(admin, 'actor', vi.fn().mockRejectedValue(other), repair)).rejects.toBe(other);
  expect(repair).not.toHaveBeenCalled();
});
