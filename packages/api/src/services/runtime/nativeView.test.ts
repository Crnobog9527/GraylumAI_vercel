/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
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

it('answers another actor\'s, missing or out-of-scope sessions with one indistinguishable not-found',async()=>{
 const db={rpc:vi.fn(async()=>({data:null,error:{code:'P0001',message:'RUNTIME_SCOPE_DENIED'}}))};
 await expect(readNativeRuntimeView(db as unknown as SupabaseClient,actor,session))
  .rejects.toMatchObject({code:'NOT_FOUND',message:'RUNTIME_SESSION_NOT_FOUND'});
});

describe('LIB-4b: a paused round shows no body once its referenced source is gone', () => {
  const round = (executionId: string, body: string) => ({ executionId, state: 'waiting_credits', contentAvailable: true, primaryBody: body });
  const refs = { libraryReferences: [{ documentId: 'd', version: 1 }] };
  // reads: per execution the runtime_execution answer; marked: executions SQL marks source_deleted on that read.
  function source(reads: Record<string, { data?: unknown; error?: unknown }>, visible = true) {
    const marked = new Set<string>();
    const rpc = vi.fn(async (name: string, args: { p_execution_id?: string }) => {
      if (name === 'runtime_execution') {
        const read = reads[args.p_execution_id!]!;
        if ((read.data as { unavailableReason?: string } | undefined)?.unavailableReason === 'source_deleted') marked.add(args.p_execution_id!);
        return { data: null, error: null, ...read };
      }
      if (name === 'runtime_library_visible') return { data: visible, error: null };
      const executions = [round('a', 'PRIVATE_A'), round('b', 'PRIVATE_B'), round('c', 'KEPT_C')]
        .map(e => marked.has(e.executionId) ? { ...e, primaryBody: null, unavailableReason: 'source_deleted' } : e);
      return { data: { sessionId: session, executions }, error: null };
    });
    return { db: { rpc } as unknown as SupabaseClient, rpc };
  }
  const plain = { data: { unavailableReason: null, context: {} } };
  it('a deletion marked by the read is reread; a failed read stays hidden across that reread', async () => {
    const f = source({ a: { error: { message: 'RUNTIME_SCOPE_DENIED' } }, b: { data: { unavailableReason: 'source_deleted' } }, c: plain });
    const text = JSON.stringify(await readNativeRuntimeView(f.db, actor, session));
    expect(text).not.toMatch(/PRIVATE_A|PRIVATE_B/);expect(text).toContain('KEPT_C');
    expect(f.rpc.mock.calls.filter(([name]) => name === 'runtime_view')).toHaveLength(2);
    expect(f.rpc).toHaveBeenCalledWith('runtime_execution', { p_actor_id: actor, p_execution_id: 'a', p_action: 'read' });
  });
  it('a referencing round whose document changed version is hidden; rounds without references are not rechecked', async () => {
    const f = source({ a: { data: { unavailableReason: null, context: refs } }, b: plain, c: plain }, false);
    const text = JSON.stringify(await readNativeRuntimeView(f.db, actor, session));
    expect(text).not.toContain('PRIVATE_A');expect(text).toMatch(/PRIVATE_B[\s\S]*KEPT_C/);
    expect(f.rpc.mock.calls.filter(([name]) => name === 'runtime_library_visible')).toHaveLength(1);
    expect(f.rpc.mock.calls.filter(([name]) => name === 'runtime_view')).toHaveLength(1);
    const live = source({ a: { data: { unavailableReason: null, context: refs } }, b: plain, c: plain }, true);
    expect(JSON.stringify(await readNativeRuntimeView(live.db, actor, session))).toContain('PRIVATE_A');
  });
  it('a running round is probed read-only, never read through runtime_execution', async () => {
    const view = (executions: unknown[]) => ({ data: { sessionId: session, executions }, error: null });
    for (const [probe, visible, shown] of [
      [{ error: { message: 'LIB_REFERENCE_READ_DENIED' } }, false, true],
      [{ data: { kind: 'unavailable', reason: 'unknown_query' } }, true, true],
      [{ data: { kind: 'unavailable', reason: 'unknown_query' } }, false, false],
      [{ error: { message: 'timeout' } }, true, false],
    ] as const) {
      const rpc = vi.fn(async (name: string) => name === 'runtime_view'
        ? view([{ executionId: 'r', state: 'running', contentAvailable: true, primaryBody: 'RUNNING_BODY' }])
        : name === 'runtime_library_read' ? { data: null, error: null, ...probe } : { data: visible, error: null });
      const text = JSON.stringify(await readNativeRuntimeView({ rpc } as unknown as SupabaseClient, actor, session));
      expect(text.includes('RUNNING_BODY')).toBe(shown);
      expect(rpc.mock.calls.map(([name]) => name)).not.toContain('runtime_execution');
      expect(rpc).toHaveBeenCalledWith('runtime_library_read', { p_actor_id: actor, p_execution_id: 'r', p_query: 'doc-0' });
    }
  });
});
