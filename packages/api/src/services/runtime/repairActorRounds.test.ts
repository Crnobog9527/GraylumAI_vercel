/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { repairActorRounds } from './automaticRecovery';

const actorId = '10000000-0000-4000-8000-000000000001';
const executionId = '10000000-0000-4000-8000-000000000002';
const runId = '10000000-0000-4000-8000-000000000003';
function admin(ended: string, delayMs = 0) {
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    const data = args.p_execution_id ? { state: ended } : [{ executionId, actorId, runId, epoch: 1 }];
    const result = new Promise(resolve => setTimeout(() => resolve({ data, error: null }), delayMs));
    return Object.assign(result, { abortSignal: () => result });
  });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}

// Line D2: an admission blocked by an earlier round of this actor repairs it once, within 2 seconds.
it('closes this actor\'s dead round through the interrupted recovery, scoped to the actor', async () => {
  const a = admin('cancelled');
  expect(await repairActorRounds(a.client, actorId)).toBe(true);
  expect(a.rpc.mock.calls.map(([name, args]) => [name, args.p_actor_id])).toEqual([
    ['runtime_interrupted_recovery', actorId], ['runtime_interrupted_recovery', actorId]]);
});

it('reports nothing to retry when no round of this actor can be closed', async () => {
  const a = admin('cancelled');
  a.rpc.mockImplementation(() => { const r = Promise.resolve({ data: [], error: null }); return Object.assign(r, { abortSignal: () => r }); });
  expect(await repairActorRounds(a.client, actorId)).toBe(false);
});

it('stops sending requests once its time is spent', async () => {
  // The inventory fits; a 500 ms step for the round would end past the deadline, so it is left for the scheduled run.
  const a = admin('cancelled', 150);
  expect(await repairActorRounds(a.client, actorId, 600)).toBe(false);
  expect(a.rpc).toHaveBeenCalledTimes(1);
  const none = admin('cancelled');
  expect(await repairActorRounds(none.client, actorId, 100)).toBe(false);
  expect(none.rpc).not.toHaveBeenCalled();
});
