/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { endClosedResume } from './executionStream';

const actorId = '10000000-0000-4000-8000-000000000001';
const executionId = '10000000-0000-4000-8000-000000000002';
const host = (rpc: ReturnType<typeof vi.fn>) => ({ admin: { rpc }, user: {}, actorId } as never);
const closed = { state: 'waiting_resume' as const, body: 'saved reply', unavailable: 'RUNTIME_PRICE_CONFIGURATION_PENDING' as const,
  resumeClosed: true as const };

// staging 2026-10-24: the organizer waited on a test window that was then switched off, blocking every new message.
it('ends a round that can never resume, keeping its delivered reply', async () => {
  const rpc = vi.fn(async () => ({ data: { state: 'cancelled' }, error: null }));
  expect(await endClosedResume(host(rpc), executionId, closed))
    .toEqual({ state: 'cancelled', body: 'saved reply', resumeClosed: true });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('runtime_cancel', { p_actor_id: actorId, p_execution_id: executionId });
});

it('leaves every other wait, and a closed round without a saved reply, untouched', async () => {
  const rpc = vi.fn();
  const ordinary = { ...closed, resumeClosed: undefined };
  expect(await endClosedResume(host(rpc), executionId, ordinary)).toBe(ordinary);
  const unsaved = { ...closed, body: undefined };
  expect(await endClosedResume(host(rpc), executionId, unsaved)).toBe(unsaved);
  expect(rpc).not.toHaveBeenCalled();
});

it('a failed cancellation propagates instead of admitting the new message', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { code: '57014', message: 'timeout' } }));
  await expect(endClosedResume(host(rpc), executionId, closed)).rejects.toThrow();
});
