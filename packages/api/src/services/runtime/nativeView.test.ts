/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readNativeRuntimeView } from './nativeView';
const actor = '10000000-0000-4000-8000-000000000001';
const session = '10000000-0000-4000-8000-000000000002';
const visible = { contentAvailable: true, body: 'authorized body', state: 'completed' };
function fixture(executions: unknown[]) {
  const view = { sessionId: session, scope: { kind: 'owned' }, activeExecution: null, executions };
  const rpc = vi.fn(async (name: string) => {
    if (name !== 'runtime_view') throw new Error('Unexpected per-execution read');
    return { data: view, error: null };
  });
  return { db: { rpc } as unknown as SupabaseClient, rpc, view };
}
it('returns all authorized historical metadata directly from one view query', async () => {
  const metadata = { completeness: 'length_limit', organized: false, summaryOmitted: true,
    messageFirst: false, envelopeCompact: true };
  const f = fixture([
    { ...visible, executionId: 'older', ...metadata },
    { ...visible, executionId: 'complete', completeness: 'complete', organized: true },
    { ...visible, executionId: 'legacy' },
    { executionId: 'hidden', contentAvailable: false, body: null },
    { executionId: 'pending', contentAvailable: true, body: null },
  ]);
  expect(await readNativeRuntimeView(f.db, actor, session)).toEqual(f.view);
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('runtime_view', { p_actor_id: actor, p_session_id: session });
});
it('preserves legacy, empty and unfinished view shapes without enrichment', async () => {
  const f = fixture([{ ...visible, executionId: 'legacy' }, { contentAvailable: true, body: '' }]);
  expect(await readNativeRuntimeView(f.db, actor, session)).toEqual(f.view);
  expect(f.rpc).toHaveBeenCalledOnce();
});
it.each(['error', 'missing', 'session', 'executions'])('fails closed on invalid %s view', async kind => {
  const f = fixture([]);
  const data = kind === 'missing' ? null : { ...f.view,
    ...(kind === 'session' ? { sessionId: actor } : {}),
    ...(kind === 'executions' ? { executions: null } : {}),
  };
  const db = { rpc: vi.fn(async () => ({ data, error: kind === 'error' ? { message: 'private database detail' } : null })) };
  await expect(readNativeRuntimeView(db as unknown as SupabaseClient, actor, session)).rejects.toThrow(/^RUNTIME_VIEW_DENIED$/);
  expect(db.rpc).toHaveBeenCalledOnce();
});
it('keeps a 1000-turn history to one query and retains every truncation marker', async () => {
  const f = fixture(Array.from({ length: 1000 }, (_, index) => ({
    ...visible, executionId: 'execution-' + index, completeness: 'length_limit',
  })));
  const result = await readNativeRuntimeView(f.db, actor, session);
  expect(result.executions).toHaveLength(1000);
  expect(result.executions.every((row: { completeness: string }) => row.completeness === 'length_limit')).toBe(true);
  expect(f.rpc).toHaveBeenCalledOnce();
});
it.each(['bill2.v1', 'bill2.v2'])('passes %s userStopPending through without relying on billing pausedReason', async contractVersion => {
  const f = fixture([
    { executionId: 'pending', userStopPending: true, body: null, billing: { contractVersion } },
    { ...visible, executionId: 'saved', stopped: true, userStopPending: false, billing: { contractVersion } },
    { executionId: 'cancelled', state: 'cancelled', userStopPending: false, billing: { contractVersion } },
  ]);
  expect(await readNativeRuntimeView(f.db, actor, session)).toEqual(f.view);
  expect(f.rpc).toHaveBeenCalledOnce();
});

it('returns an explicit tombstone refusal instead of an empty successful view',async()=>{
 const db={rpc:async()=>({data:null,error:{code:'42501',message:'CONTENT_ERASED'}})};
 await expect(readNativeRuntimeView(db as unknown as SupabaseClient,actor,session))
  .rejects.toMatchObject({code:'PRECONDITION_FAILED',message:'CONTENT_ERASED'});
});
