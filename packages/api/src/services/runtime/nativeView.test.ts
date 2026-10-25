/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readNativeRuntimeView, readNativeRuntimeViewWithWorkItems } from './nativeView';
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

describe('LIB-4b: unfinished rounds show no body once a referenced source is gone', () => {
  const rows = [
    { executionId: 'waiting', state: 'waiting_credits', contentAvailable: true, primaryBody: 'GONE_WAITING' },
    { executionId: 'interrupted', state: 'interrupted', contentAvailable: true, primaryBody: 'KEPT_INTERRUPTED' },
    { executionId: 'running', state: 'running', contentAvailable: true, primaryBody: 'GONE_RUNNING' },
    { executionId: 'marked', state: 'cost_pending', unavailableReason: 'source_deleted', primaryBody: 'GONE_MARKED' },
    { ...visible, executionId: 'done', body: 'KEPT_DONE' },
    { executionId: 'stopped', state: 'cancelled', contentAvailable: true, body: 'KEPT_STOPPED' },
    { executionId: 'empty', state: 'waiting_resume', contentAvailable: true, primaryBody: null },
  ];
  function source(gone: { data?: unknown; error?: unknown }) {
    const rpc = vi.fn(async (name: string) => name === 'runtime_view'
      ? { data: { sessionId: session, executions: structuredClone(rows) }, error: null } : { data: null, error: null, ...gone });
    return { db: { rpc } as unknown as SupabaseClient, rpc };
  }
  it('asks once, read-only, about every unfinished round that shows a body and hides the gone ones', async () => {
    const f = source({ data: ['waiting', 'running'] });
    const text = JSON.stringify(await readNativeRuntimeView(f.db, actor, session));
    expect(text).not.toMatch(/GONE_/);expect(text).toMatch(/KEPT_INTERRUPTED[\s\S]*KEPT_DONE[\s\S]*KEPT_STOPPED/);
    expect(f.rpc.mock.calls).toEqual([['runtime_view', { p_actor_id: actor, p_session_id: session }],
      ['runtime_library_sources_gone', { p_actor_id: actor, p_execution_ids: ['waiting', 'interrupted', 'running'] }]]);
  });
  it('fails closed for unfinished rounds when the check is unavailable, keeping finished answers', async () => {
    const text = JSON.stringify(await readNativeRuntimeView(source({ error: { code: '57014' } }).db, actor, session));
    expect(text).not.toMatch(/GONE_|KEPT_INTERRUPTED/);expect(text).toMatch(/KEPT_DONE[\s\S]*KEPT_STOPPED/);
  });
});

describe('DB-PERF PR-5a: the refresh reads the view and the work rows in one call', () => {
  const view = { sessionId: session, scope: { kind: 'owned' }, activeExecution: null,
    executions: [{ ...visible, executionId: 'done' }] };
  const one = (data: unknown, error: unknown = null) => {
    const rpc = vi.fn(async () => ({ data, error }));
    return { db: { rpc } as unknown as SupabaseClient, rpc };
  };
  it('returns both from runtime_view_with_work_items, rows by answer', async () => {
    const f = one({ view, workItems: { done: [{ kind: 'read' }], empty: [] } });
    expect(await readNativeRuntimeViewWithWorkItems(f.db, actor, session)).toEqual({ view, workItems: { done: [{ kind: 'read' }] } });
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('runtime_view_with_work_items', { p_actor_id: actor, p_session_id: session });
  });
  it('keeps the view when the rows are missing or malformed (decorative, as before)', async () => {
    for (const workItems of [undefined, null, [], 'x'])
      expect(await readNativeRuntimeViewWithWorkItems(one({ view, workItems }).db, actor, session)).toEqual({ view, workItems: {} });
  });
  it('refuses exactly as the view does: another actor or a missing session is not found, other failures are denied', async () => {
    await expect(readNativeRuntimeViewWithWorkItems(one(null, { code: 'P0001', message: 'RUNTIME_SCOPE_DENIED' }).db, actor, session))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'RUNTIME_SESSION_NOT_FOUND' });
    await expect(readNativeRuntimeViewWithWorkItems(one(null, { code: '42501', message: 'CONTENT_ERASED' }).db, actor, session))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'CONTENT_ERASED' });
    for (const data of [null, { workItems: {} }, { view: { ...view, sessionId: actor } }])
      await expect(readNativeRuntimeViewWithWorkItems(one(data).db, actor, session)).rejects.toThrow(/^RUNTIME_VIEW_DENIED$/);
  });
});
