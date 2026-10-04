/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readNativeRuntimeView } from './nativeView';
const actor = '10000000-0000-4000-8000-000000000001';
const session = '10000000-0000-4000-8000-000000000002';
const execution = '10000000-0000-4000-8000-000000000003';
const visible = { executionId: execution, contentAvailable: true, body: 'authorized body', state: 'completed' };
function fixture(executions: unknown[], rows: Record<string, unknown>[] = [], viewError = false, rowError = false) {
  const calls: unknown[][] = [];
  const view = { sessionId: session, scope: { kind: 'owned' }, activeExecution: null, executions };
  const db = {
    rpc: async (name: string, args: { p_execution_id?: string }) => {
      calls.push(['rpc', name, args]);
      if (name === 'runtime_view') return { data: view, error: viewError ? { message: 'private scope error' } : null };
      if (name !== 'runtime_execution') throw new Error('unexpected RPC');
      return { data: rows.find(row => row.executionId === args.p_execution_id) ?? rows[0] ?? null,
        error: rowError ? { message: 'private database error' } : null };
    },
    from: () => { throw new Error('service_role has no direct SELECT grant'); },
  };
  return { db: db as unknown as SupabaseClient, calls, view };
}
const saved = (result: Record<string, unknown>, id = execution) => ({
  executionId: id, sessionId: session, runId: 'private run', state: 'completed', live: false,
  cancelRequested: false, context: { input: 'private context' }, billing: { private: 'billing' },
  result: { kind: 'usable_result', body: 'private body', summary: 'private summary', ...result },
  primaryResult: { body: 'private checkpoint' }, matchResult: { private: 'match' },
});

it('authorizes via runtime_view then scoped read RPC and exposes only whitelisted result metadata', async () => {
  const metadata = { completeness: 'length_limit', organized: false, summaryOmitted: true, messageFirst: false, envelopeCompact: true };
  const f = fixture([visible], [saved(metadata)]);
  const result = await readNativeRuntimeView(f.db, actor, session);
  expect(result).toEqual({ ...f.view, executions: [{ ...visible, ...metadata }] });
  expect(f.calls).toEqual([
    ['rpc', 'runtime_view', { p_actor_id: actor, p_session_id: session }],
    ['rpc', 'runtime_execution', { p_actor_id: actor, p_execution_id: execution, p_action: 'read' }],
  ]);
  expect(JSON.stringify(result)).not.toContain('private');
});

it('does not read execution metadata for hidden, empty or unfinished replies', async () => {
  const executions = [
    { executionId: execution, contentAvailable: false, body: null },
    { executionId: 'hidden', contentAvailable: false, body: 'not authorized' },
    { executionId: 'missing', body: 'not authorized' },
    { executionId: 'pending', contentAvailable: true, body: null },
    { executionId: 'empty', contentAvailable: true, body: '' },
  ];
  const f = fixture(executions);
  expect(await readNativeRuntimeView(f.db, actor, session)).toEqual(f.view);
  expect(f.calls).toHaveLength(1);
});

it('preserves the legacy response shape when native metadata is absent or invalid', async () => {
  const f = fixture([visible], [saved({ completeness: 'invalid', organized: 'invalid' })]);
  expect(await readNativeRuntimeView(f.db, actor, session)).toEqual(f.view);
});

it.each(['execution', 'session', 'missing', 'revoked'])('fails closed on %s binding/result', async kind => {
  const row: Record<string, unknown> = saved({ completeness: 'length_limit' });
  if (kind === 'execution') row.executionId = 'foreign execution';
  if (kind === 'session') row.sessionId = 'foreign session';
  if (kind === 'missing') delete row.result;
  if (kind === 'revoked') { row.result = null; row.cancelRequested = true; }
  const f = fixture([visible], [row]);
  await expect(readNativeRuntimeView(f.db, actor, session)).rejects.toThrow(/^RUNTIME_VIEW_DENIED$/);
});

it('fails before private reads when the SQL view denies access', async () => {
  const f = fixture([visible], [], true);
  await expect(readNativeRuntimeView(f.db, actor, session)).rejects.toThrow('RUNTIME_VIEW_DENIED');
  expect(f.calls).toHaveLength(1);
});

it('fails closed on scoped read errors without leaking database details', async () => {
  const f = fixture([visible], [], false, true);
  await expect(readNativeRuntimeView(f.db, actor, session)).rejects.toThrow(/^RUNTIME_VIEW_DENIED$/);
});

it('rejects a mismatched session view before metadata reads', async () => {
  const f = fixture([]);
  f.view.sessionId = actor;
  await expect(readNativeRuntimeView(f.db, actor, session)).rejects.toThrow('RUNTIME_VIEW_DENIED');
  expect(f.calls).toHaveLength(1);
});

it('deduplicates execution reads and never exceeds eight outstanding RPCs', async () => {
  const entries = Array.from({ length: 19 }, (_, index) => ({ ...visible, executionId: 'execution-' + index }));
  const f = fixture([...entries, entries[0]], entries.map(entry => saved({ completeness: 'complete' }, entry.executionId)));
  let outstanding = 0, maximum = 0, reads = 0;
  const original = f.db.rpc.bind(f.db);
  f.db.rpc = (async (name: string, args: Record<string, unknown>) => {
    if (name !== 'runtime_execution') return original(name, args);
    reads++;
    outstanding++;
    maximum = Math.max(maximum, outstanding);
    await new Promise(resolve => setTimeout(resolve, 0));
    try { return await original(name, args); }
    finally { outstanding--; }
  }) as unknown as typeof f.db.rpc;
  const result = await readNativeRuntimeView(f.db, actor, session);
  expect(reads).toBe(19);
  expect(maximum).toBe(8);
  expect(result.executions).toHaveLength(20);
  expect(outstanding).toBe(0);
});
