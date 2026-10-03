/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it, expect, vi } from 'vitest';
import { capturePending, captureCompleted } from './capture';
import type { SupabaseClient } from '@supabase/supabase-js';

it.each([0, 5, 6, 20, 21])('capture drains at most four batches, without new work (%i)', async count => {
  let remaining = count;
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => {
    expect(_name).toBe("opc_capture_apply");
    expect(_args).toHaveProperty("p_execution_id", null);
    const n = Math.min(5, remaining);
    remaining -= n;
    return { processed: Array.from({ length: n }, () => ({ executionId: '00000000-0000-4000-8000-000000000001', result: 'suggested' })), remaining, hasMore: remaining > 0 };
  });
  const result = await capturePending(rpc, 'draft');
  expect(result.processed).toHaveLength(Math.min(count, 20));
  expect(result.remaining).toBe(Math.max(0, count - 20));
  expect(rpc).toHaveBeenCalledTimes(Math.max(1, Math.min(4, Math.ceil(count / 5))));
  expect(rpc.mock.calls.every(args => args.length === 2)).toBe(true);
});
it('capture propagates batch storage errors and does not pretend to finish', async () => {
  const rpc = vi.fn().mockRejectedValue(new Error('storage failure'));
  await expect(capturePending(rpc, 'draft')).rejects.toThrow('storage failure');
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('completion failure never prevents original result recovery', async () => {
  const abortSignal = vi.fn().mockResolvedValue({ error: { message: 'database unavailable' } });
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  await expect(captureCompleted({ rpc } as unknown as SupabaseClient, 'actor', 'execution')).resolves.toBeUndefined();
  expect(rpc).toHaveBeenCalledWith('opc_capture_apply', { p_actor_id: 'actor', p_draft_id: null, p_execution_id: 'execution' });
});

it('completion aborts a stalled RPC after its bounded deadline without hiding the result', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
  const abortSignal = vi.fn((signal: AbortSignal) => { expect(signal.aborted).toBe(true); return Promise.reject(new Error('aborted')); });
  try {
    await expect(captureCompleted({ rpc: () => ({ abortSignal }) } as unknown as SupabaseClient, 'actor', 'execution')).resolves.toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(1000); expect(abortSignal).toHaveBeenCalledOnce();
  } finally { timeout.mockRestore(); }
});
