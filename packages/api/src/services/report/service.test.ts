/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reportEnabled, reportService, reportError } from './service';
import { runtimeAdmissionService } from '../runtime/admission';
const id = randomUUID();
const input = { sessionId: id, projectId: id, roundId: id, requestId: id };
const user = { auth: { getUser: async () => ({ data: { user: { id, email_confirmed_at: '2026-01-01T00:00:00Z' } } }) } };
const policy = { account: 'synthetic', costPerCall: '0.1', creditsPerUsd: '100', multiplier: '6',
  maxCalls: 1, maxOutputTokens: 8192, inputBytes: 196608, historyItems: 0 };
it.each([null, { enabled: false }, { enabled: 'true' }, { enabled: true, extra: true }, 'invalid', '{"enabled":true}'])(
  'default-off flag rejects before membership, source, or billing (%j)', async value => {
    const rpc = vi.fn(async () => ({data:null,error:null}));
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: value === null ? null : { value }, error: null }) };
    const admin = { from: () => query, rpc } as unknown as SupabaseClient;
    await expect(reportService(user as unknown as SupabaseClient, admin, policy).start(input)).rejects.toThrow('REPORT_DISABLED');
    expect(rpc).toHaveBeenCalledOnce();
    expect((rpc.mock.calls as unknown[][])[0]?.[0]).toBe('runtime_admission_replay');
  });
it('free member is rejected before creating a report run or reading facts', async () => {
  const rpc = vi.fn(async (name: string) => ({ data: null, error: name === 'runtime_admission_replay' ? null : { message: 'REPORT_MEMBERSHIP_REQUIRED' } }));
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { value: { enabled: true } }, error: null }) };
  const admin = { from: () => query, rpc } as unknown as SupabaseClient;
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).start(input)).rejects.toMatchObject({
    code: 'FORBIDDEN', message: 'REPORT_MEMBERSHIP_REQUIRED',
  });
  expect(rpc.mock.calls).toHaveLength(2);
  expect((rpc.mock.calls as unknown[][])[1]![0]).toBe('report_membership_check');
});
it('saved reports remain readable without a flag or membership read', async () => {
  const rpc = vi.fn(async () => ({ error: null, data: { state: 'completed', result: { body: '## One\nSaved', completeness: 'complete' },
    context: { reportGeneration: { version: 1, projectId: id, roundId: id, snapshotHash: 'a'.repeat(64),
      packageHash: 'b'.repeat(64), workflowHash: 'c'.repeat(64), templateHash: 'd'.repeat(64), sections: ['One'], maxCharacters: 12000 } } } }));
  const from = vi.fn(() => { throw new Error('UNEXPECTED_MEMBERSHIP_READ'); });
  const service = reportService(user as unknown as SupabaseClient, { rpc, from } as unknown as SupabaseClient, policy);
  expect(await service.status(id)).toMatchObject({ state: 'completed', body: '## One\nSaved', candidate: true });
  expect(from).not.toHaveBeenCalled();
  expect((rpc.mock.calls as unknown[][])[0]![0]).toBe('runtime_execution');
});

it('non-report execution returns a stable 400 error', async () => {
  const admin = { rpc: async () => ({ data: { context: {} }, error: null }) } as unknown as SupabaseClient;
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).status(id))
    .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'REPORT_EXECUTION_REQUIRED' });
});
it('existing request replay precedes settings, membership and source reads', async () => {
  const data = { executionId: id, runId: id, state: 'waiting_credits' };
  const rpc = vi.fn(async () => ({ data, error: null }));
  const from = vi.fn(() => { throw new Error('NO_NEW_ADMISSION_READ'); });
  const admin = { rpc, from } as unknown as SupabaseClient;
  expect(await reportService(user as unknown as SupabaseClient, admin, policy).start(input)).toEqual(data);
  expect(rpc).toHaveBeenCalledWith('runtime_admission_replay', {
    p_actor_id: id, p_request_id: id, p_request: { reportStart: input },
  });
  expect(from).not.toHaveBeenCalled();
});

it('SQL OPC_CAPTURE_PENDING survives admission and the report error boundary', async () => {
  const admin = { rpc: async () => ({ data: null, error: {code:'P0001',message:'OPC_CAPTURE_PENDING'} }) } as unknown as SupabaseClient;
  const admission = runtimeAdmissionService(user as unknown as SupabaseClient, admin, { ...policy,
    reportGeneration: {version:1,projectId:id,roundId:id,evidenceIds:[],snapshotHash:'a'.repeat(64),
      packageHash:'b'.repeat(64),workflowHash:'c'.repeat(64),templateHash:'d'.repeat(64),sections:['One'],maxCharacters:12000},
  });
  await expect(admission.prepare({sessionId:id,requestId:id,input:'report',selection:{kind:'ordinary',modelId:id},
    organizeAfter:false,sources:[],network:'deny'}).catch(reportError))
    .rejects.toMatchObject({code:'BAD_REQUEST',message:'OPC_CAPTURE_PENDING'});
});
it.each([[{ enabled: true }, true], [null, false], [{ enabled: false }, false], ['{"enabled":true}', false], [{ enabled: true, extra: 1 }, false]])(
  'reportEnabled reads the same strict switch as start (%j)', async (value, expected) => {
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: value === null ? null : { value }, error: null }) };
    expect(await reportEnabled({ from: () => query } as unknown as SupabaseClient)).toBe(expected);
  });
it('reportEnabled fails closed on a read error', async () => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: { message: 'x' } }) };
  await expect(reportEnabled({ from: () => query } as unknown as SupabaseClient)).rejects.toThrow('REPORT_UNAVAILABLE');
});
function latestAdmin(view: unknown, row: { id: string } | null) {
  const calls: unknown[][] = [];
  const query = new Proxy({} as Record<string, unknown>, { get: (_t, name: string) => name === 'maybeSingle'
    ? async () => ({ data: row, error: null }) : (...args: unknown[]) => { calls.push([name, ...args]); return query; } });
  const rpc = vi.fn(async () => view === null ? { data: null, error: { message: 'RUNTIME_SCOPE_DENIED' } } : { data: view, error: null });
  const from = vi.fn((table: string) => { calls.push(['from', table]); return query; });
  return { admin: { rpc, from } as unknown as SupabaseClient, calls, from };
}
const locate = { sessionId: id, projectId: randomUUID(), roundId: randomUUID() };
it('latest finds the newest report of this project and round in an owned session, without switch or membership reads', async () => {
  const other = randomUUID();
  const { admin, calls } = latestAdmin({ sessionId: id, executions: [] }, { id: other });
  expect(await reportService(user as unknown as SupabaseClient, admin, policy).latest(locate)).toEqual({ executionId: other });
  expect(calls).toEqual([['from', 'runtime_executions'], ['select', 'id'], ['eq', 'session_id', id],
    ['filter', 'payload->reportGeneration->>projectId', 'eq', locate.projectId],
    ['filter', 'payload->reportGeneration->>roundId', 'eq', locate.roundId],
    ['order', 'created_at', { ascending: false }], ['limit', 1]]);
});
it('latest returns null when the round has no report', async () => {
  const { admin } = latestAdmin({ sessionId: id, executions: [] }, null);
  expect(await reportService(user as unknown as SupabaseClient, admin, policy).latest(locate)).toEqual({ executionId: null });
});
it('latest refuses a session the actor cannot view before reading executions', async () => {
  const { admin, from } = latestAdmin(null, { id });
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).latest(locate)).rejects.toMatchObject({ message: 'REPORT_UNAVAILABLE' });
  expect(from).not.toHaveBeenCalled();
});
it('latest rejects extra input such as a requestId', async () => {
  const { admin } = latestAdmin({ sessionId: id, executions: [] }, null);
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).latest({ ...locate, requestId: id })).rejects.toThrow();
});
