/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { REPORT_REQUEST_INPUT, reportEnabled, reportService, reportError } from './service';
import { runtimeAdmissionService } from '../runtime/admission';
const id = randomUUID();
const input = { sessionId: id, projectId: id, roundId: id, requestId: id };
const user = { auth: { getUser: async () => ({ data: { user: { id, email_confirmed_at: '2026-01-01T00:00:00Z' } } }) } };
const policy = { account: 'synthetic', costPerCall: '0.1', creditsPerUsd: '100', multiplier: '6',
  maxCalls: 1, maxOutputTokens: 8192, inputBytes: 196608, historyItems: 0 };
const workflow = (supported = true) => ({ id: 'fixture', version: 1, kind: 'document',
  steps: [{ id: 'step', title: 'Step', dependsOn: [], resources: ['step.md'], minLength: 1, maxLength: 100,
    requiresEvidence: false, requiredCapabilities: [] }],
  report: { id: 'report', version: 1, title: 'Report', sections: [{ title: 'One', stepId: 'step' }] },
  ...(supported ? { reportGeneration: { resources: ['report.md'], sections: ['One'], maxCharacters: 12000 } } : {}),
});
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
  const rpc = vi.fn(async (name: string) => {
    if (name === 'runtime_admission_replay') return { data: null, error: null };
    if (name === 'report_source') return { data: { workflow: workflow(),
      get snapshot() { throw new Error('FACTS_READ_BEFORE_MEMBERSHIP'); } }, error: null };
    return { data: null, error: { message: 'REPORT_MEMBERSHIP_REQUIRED' } };
  });
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { value: { enabled: true } }, error: null }) };
  const admin = { from: () => query, rpc } as unknown as SupabaseClient;
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).start(input)).rejects.toMatchObject({
    code: 'FORBIDDEN', message: 'REPORT_MEMBERSHIP_REQUIRED',
  });
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['runtime_admission_replay', 'report_source', 'report_membership_check']);
});
it.each([false, true])('missing report manifest precedes membership for paid=%s', async paid => {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'runtime_admission_replay') return { data: null, error: null };
    if (name === 'report_source') return { data: { workflow: workflow(false),
      get snapshot() { throw new Error('UNEXPECTED_FACTS_READ'); } }, error: null };
    if (name === 'report_membership_check') return { data: null, error: paid ? null : { message: 'REPORT_MEMBERSHIP_REQUIRED' } };
    throw new Error('UNEXPECTED_ADMISSION_OR_BILLING');
  });
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { value: { enabled: true } }, error: null }) };
  const admin = { from: () => query, rpc } as unknown as SupabaseClient;
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).start(input)).rejects.toMatchObject({
    code: 'BAD_REQUEST', message: 'REPORT_MANIFEST_REQUIRED',
  });
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['runtime_admission_replay', 'report_source']);
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
const locate = { sessionId: id, projectId: randomUUID(), roundId: randomUUID() };
const frozen = (projectId: string, roundId: string) => ({ reportGeneration: { version: 1, projectId, roundId, snapshotHash: 'a'.repeat(64),
  packageHash: 'b'.repeat(64), workflowHash: 'c'.repeat(64), templateHash: 'd'.repeat(64), sections: ['One'], maxCharacters: 12000 } });
function latestAdmin(executions: unknown[] | null, contexts: Record<string, unknown>) {
  const rpc = vi.fn(async (name: string, args: { p_execution_id?: string }) => name === 'runtime_view'
    ? executions === null ? { data: null, error: { message: 'RUNTIME_SCOPE_DENIED' } } : { data: { sessionId: id, executions }, error: null }
    : { data: { state: 'completed', context: contexts[args.p_execution_id!] ?? {} }, error: null });
  const from = vi.fn(() => { throw new Error('NO_DIRECT_TABLE_READ'); });
  return { admin: { rpc, from } as unknown as SupabaseClient, rpc, from };
}
const run = (input: string, createdAt: string, extra: Record<string, unknown> = {}) =>
  ({ executionId: randomUUID(), input, request: null, createdAt, ...extra });
it('latest returns the newest report of this project and round through granted RPCs only', async () => {
  const older = run(REPORT_REQUEST_INPUT, '2026-10-01T00:00:00Z'), newer = run(REPORT_REQUEST_INPUT, '2026-10-02T00:00:00Z');
  const otherRound = run(REPORT_REQUEST_INPUT, '2026-10-03T00:00:00Z'), chat = run('hello', '2026-10-04T00:00:00Z');
  const { admin, rpc, from } = latestAdmin([older, chat, otherRound, newer], {
    [older.executionId]: frozen(locate.projectId, locate.roundId), [newer.executionId]: frozen(locate.projectId, locate.roundId),
    [otherRound.executionId]: frozen(locate.projectId, randomUUID()) });
  expect(await reportService(user as unknown as SupabaseClient, admin, policy).latest(locate)).toEqual({ executionId: newer.executionId });
  expect(from).not.toHaveBeenCalled();
  // The ordinary chat turn is never read; candidates are confirmed newest first.
  expect(rpc.mock.calls.map(call => call[0] === 'runtime_view' ? 'view' : (call[1] as { p_execution_id: string }).p_execution_id))
    .toEqual(['view', otherRound.executionId, newer.executionId]);
});
it('latest ignores a mentor turn even with the same text and returns null without a report', async () => {
  const mentor = run(REPORT_REQUEST_INPUT, '2026-10-01T00:00:00Z', { request: { purpose: 'mentor' } });
  const { admin, rpc } = latestAdmin([mentor], { [mentor.executionId]: frozen(locate.projectId, locate.roundId) });
  expect(await reportService(user as unknown as SupabaseClient, admin, policy).latest(locate)).toEqual({ executionId: null });
  expect(rpc).toHaveBeenCalledOnce();
});
it('latest refuses a session the actor cannot view before reading any execution', async () => {
  const { admin, rpc } = latestAdmin(null, {});
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).latest(locate)).rejects.toMatchObject({ message: 'REPORT_UNAVAILABLE' });
  expect(rpc).toHaveBeenCalledOnce();
});
it('latest rejects extra input such as a requestId', async () => {
  const { admin } = latestAdmin([], {});
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).latest({ ...locate, requestId: id })).rejects.toThrow();
});
function startAdmin(executions: unknown[], saved: Record<string, { state: string; result: unknown; context: unknown }>) {
  const past = { reached: false };
  const rpc = vi.fn(async (name: string, args: { p_execution_id?: string }) => {
    if (name === 'runtime_admission_replay' || name === 'report_membership_check') return { data: null, error: null };
    if (name === 'runtime_view') return { data: { sessionId: id, executions }, error: null };
    if (name === 'runtime_execution') return { data: saved[args.p_execution_id!], error: null };
    // The source read comes first; reading its snapshot means the one-report check let the start through.
    if (name === 'report_source') return { data: { workflow: workflow(), get snapshot() { past.reached = true; return null; } }, error: null };
    return { data: null, error: { message: 'UNEXPECTED_RPC' } };
  });
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { value: { enabled: true } }, error: null }) };
  return { admin: { rpc, from: () => query } as unknown as SupabaseClient, rpc, past };
}
const startInput = { ...locate, requestId: randomUUID() };
it.each([
  ['a complete report', 'completed', { body: '## One\nx', completeness: 'complete' }],
  ['a truncated report', 'completed', { body: '## One\nx', completeness: 'length_limit' }],
  ['a stopped report with text', 'completed', { body: 'x', completeness: 'stopped' }],
  ['a running report', 'running', null], ['a report waiting for credits', 'waiting_credits', null],
  ['a report waiting to resume', 'waiting_resume', null], ['a report settling its cost', 'cost_pending', null],
])('a stale tab with a new requestId is refused when the round has %s', async (_name, state, result) => {
  const existing = run(REPORT_REQUEST_INPUT, '2026-10-02T00:00:00Z');
  const { admin, past } = startAdmin([existing], { [existing.executionId]: { state, result, context: frozen(locate.projectId, locate.roundId) } });
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).start(startInput))
    .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'REPORT_ALREADY_EXISTS' });
  expect(past.reached).toBe(false);
});
it.each([['cancelled', null], ['completed', { body: '', completeness: 'complete' }], ['completed', null]])(
  'a round whose last report ended %s without text still allows a new start', async (state, result) => {
    const existing = run(REPORT_REQUEST_INPUT, '2026-10-02T00:00:00Z');
    const { admin, past } = startAdmin([existing], { [existing.executionId]: { state, result, context: frozen(locate.projectId, locate.roundId) } });
    await expect(reportService(user as unknown as SupabaseClient, admin, policy).start(startInput)).rejects.toMatchObject({ message: 'REPORT_UNAVAILABLE' });
    expect(past.reached).toBe(true);
  });
it('a report of another round or project does not block this round', async () => {
  const otherRound = run(REPORT_REQUEST_INPUT, '2026-10-02T00:00:00Z'), otherProject = run(REPORT_REQUEST_INPUT, '2026-10-03T00:00:00Z');
  const done = { state: 'completed', result: { body: 'x', completeness: 'complete' } };
  const { admin, past } = startAdmin([otherRound, otherProject], {
    [otherRound.executionId]: { ...done, context: frozen(locate.projectId, randomUUID()) },
    [otherProject.executionId]: { ...done, context: frozen(randomUUID(), locate.roundId) } });
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).start(startInput)).rejects.toMatchObject({ message: 'REPORT_UNAVAILABLE' });
  expect(past.reached).toBe(true);
});
it('the same requestId replays the existing execution before any one-report check', async () => {
  const replayed = { executionId: id, runId: id, state: 'completed' };
  const rpc = vi.fn(async () => ({ data: replayed, error: null }));
  const service = reportService(user as unknown as SupabaseClient, { rpc } as unknown as SupabaseClient, policy);
  expect(await service.start(startInput)).toEqual(replayed);
  expect(rpc).toHaveBeenCalledOnce();
});

it.each([
  ['RUNTIME_STAGING_MODEL_NOT_APPROVED', 'REPORT_MODEL_ADMISSION_REQUIRED'],
  ['RUNTIME_PRICE_SNAPSHOT_MISSING', 'REPORT_MODEL_PRICING_UNAVAILABLE'],
  ['RUNTIME_PRICE_INCREASED', 'REPORT_MODEL_PRICING_UNAVAILABLE'],
  ['RUNTIME_MODEL_CAPABILITY_UNVERIFIED', 'REPORT_MODEL_UNAVAILABLE'],
  ['RUNTIME_PAYG_PROFILE_REQUIRED', 'REPORT_MODEL_ADMISSION_REQUIRED'],
  ['BILL2_START_THRESHOLD_UNCONFIGURED', 'REPORT_MODEL_ADMISSION_REQUIRED'],
  ['RUNTIME_REASONING_CONFIG_INVALID', 'REPORT_MODEL_ADMISSION_REQUIRED'],
  ['private database failure', 'REPORT_UNAVAILABLE'],
])('report boundary maps %s to a stable public code', (internal, expected) => {
  expect(() => reportError(new Error(internal))).toThrow(expected);
});
