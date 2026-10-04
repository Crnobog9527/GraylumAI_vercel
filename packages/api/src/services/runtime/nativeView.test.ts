/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readNativeRuntimeView } from './nativeView';
const actor = '10000000-0000-4000-8000-000000000001';
const session = '10000000-0000-4000-8000-000000000002';
const execution = '10000000-0000-4000-8000-000000000003';
function fixture(executions: unknown[], rows: unknown[] = [], viewError = false, rowError = false) {
  const calls: unknown[][] = [];
  const view = { sessionId: session, scope: { kind: 'owned' }, activeExecution: null, executions };
  const chain = {
    select: (value: string) => { calls.push(['select', value]); return chain; },
    eq: (key: string, value: string) => { calls.push(['eq', key, value]); return chain; },
    in: async (key: string, values: string[]) => {
      calls.push(['in', key, values]);
      return { data: rows, error: rowError ? { message: 'private error' } : null };
    },
  };
  const db = {
    rpc: async (name: string, args: unknown) => {
      calls.push(['rpc', name, args]);
      return { data: view, error: viewError ? { message: 'private scope error' } : null };
    },
    from: (name: string) => { calls.push(['from', name]); return chain; },
  };
  return { db: db as unknown as SupabaseClient, calls, view };
}
it('authorizes via runtime_view first and reads only metadata with actor/session/execution filters', async () => {
  const visible = { executionId: execution, contentAvailable: true, body: 'authorized body', summary: 'authorized summary', state: 'completed' };
  const metadata = { completeness: 'length_limit', organized: false, summaryOmitted: true, messageFirst: false, envelopeCompact: true };
  const f = fixture([visible], [{ id: execution, ...metadata, body: 'private body', payload: 'private payload' }]);
  const result = await readNativeRuntimeView(f.db, actor, session);
  expect(result).toEqual({ ...f.view, executions: [{ ...visible, ...metadata }] });
  expect(f.calls[0]).toEqual(['rpc', 'runtime_view', { p_actor_id: actor, p_session_id: session }]);
  expect(f.calls.slice(3)).toEqual([['eq', 'actor_id', actor], ['eq', 'session_id', session], ['in', 'id', [execution]]]);
  const selected = String(f.calls[2]?.[1]);
  expect(selected).toContain('completeness:result->completeness');
  expect(selected).not.toMatch(/body|summary:|payload|result,/);
  expect(JSON.stringify(result)).not.toContain('private');
});
it('does not query metadata for hidden, empty or unfinished replies', async () => {
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
it('does not attach returned foreign metadata and preserves hidden rows and legacy shape', async () => {
  const entries = [{ executionId: execution, contentAvailable: true, body: 'legacy' },
    { executionId: 'hidden', contentAvailable: false, body: null }];
  const f = fixture(entries, [{ id: execution, completeness: 'invalid', organized: 'invalid' },
    { id: 'hidden', completeness: 'length_limit' }]);
  expect(await readNativeRuntimeView(f.db, actor, session)).toEqual(f.view);
  expect(f.calls.at(-1)).toEqual(['in', 'id', [execution]]);
});
it('fails before private reads when the SQL view denies access', async () => {
  const f = fixture([{ executionId: execution, contentAvailable: true, body: 'body' }], [], true);
  await expect(readNativeRuntimeView(f.db, actor, session)).rejects.toThrow('RUNTIME_VIEW_DENIED');
  expect(f.calls).toHaveLength(1);
});
it('fails closed on metadata errors without leaking database details', async () => {
  const f = fixture([{ executionId: execution, contentAvailable: true, body: 'body' }], [], false, true);
  await expect(readNativeRuntimeView(f.db, actor, session)).rejects.toThrow(/^RUNTIME_VIEW_DENIED$/);
});
it('rejects a mismatched session view before metadata reads', async () => {
  const f = fixture([]);
  f.view.sessionId = actor;
  await expect(readNativeRuntimeView(f.db, actor, session)).rejects.toThrow('RUNTIME_VIEW_DENIED');
  expect(f.calls).toHaveLength(1);
});
