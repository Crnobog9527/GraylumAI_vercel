/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {RateLimitError} from '../lib/rateLimitError';
const mock = vi.hoisted(() => ({prepare: vi.fn(), topic: vi.fn(), execute: vi.fn(), admission: vi.fn()}));
// Scope/auth themselves are covered by stagingAdmission; this suite exercises routing contracts.
vi.mock('../trpc', async original => {
  const actual = await original<typeof import('../trpc')>();
  return {...actual, protectedProcedure: actual.publicProcedure};
});
vi.mock('../services/opc/service', async original => {
  const actual = await original<typeof import('../services/opc/service')>();
  return {...actual, opcService: () => ({prepareStep: mock.prepare, prepareTopicTurn: mock.topic})};
});
vi.mock('../services/runtime/admission', async original => {
  const actual = await original<typeof import('../services/runtime/admission')>();
  return {...actual, runtimeAdmissionService: () => ({prepare: mock.admission})};
});
vi.mock('../services/runtime/executionStream', async original => {
  const actual = await original<typeof import('../services/runtime/executionStream')>();
  return {...actual, runtimeLocalEndpoint: () => 'http://127.0.0.1:1', executeOriginalExecution: mock.execute};
});
import {router} from '../trpc';
import {opcRouter} from './opc';
import {runtimeRouter} from './runtime';
const app = router({opc: opcRouter, runtime: runtimeRouter});
const id = '10000000-0000-4000-8000-000000000001';
const input = {draftId: id, requestId: id, stepId: 'step-0', input: 'synthetic'};
const context = {user: {id}, supabaseAdmin: {}, hasSupabaseAdminPrivileges: true,
  userScopedSupabase: {auth: {getUser: async () => ({data: {user: {id}}, error: null})}}} as never;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1');
  mock.prepare.mockResolvedValue({executionId: id});
  mock.topic.mockResolvedValue({executionId: id});
  mock.admission.mockResolvedValue({executionId: id});
  mock.execute.mockResolvedValue({state: 'completed', body: 'buffered result', completeness: 'complete'});
});
afterEach(() => vi.unstubAllEnvs());

it.each(['plan', 'workspace', 'topics'] as const)('%s retains prepare then buffered runtime.execute with no progress observer', async path => {
  const caller = app.createCaller(context);
  if (path === 'plan') await caller.opc.prepareStep({...input, purpose: 'plan'});
  if (path === 'topics') await caller.opc.topicTurn({draftId: id, requestId: id, input: 'synthetic'});
  if (path === 'workspace') await caller.runtime.prepare({sessionId: id, requestId: id, input: 'synthetic',
    selection: {kind: 'ordinary', modelId: id}, network: 'deny', organizeAfter: false});
  expect(mock.execute).not.toHaveBeenCalled();
  const result = await caller.runtime.execute({executionId: id});
  expect(result).toMatchObject({state: 'completed', body: 'buffered result'});
  expect(mock.execute).toHaveBeenCalledTimes(1);
  expect(mock.execute.mock.calls[0]![2]).toBeUndefined();
});

it('mentor stream refuses plan before admission or execution', async () => {
  const stream = await app.createCaller(context).opc.mentorTurnStream({...input, purpose: 'plan', textProtocol: 'textDelta-v1'});
  await expect((async () => { for await (const event of stream) { void event; } })()).rejects.toThrow('OPC_STEP_DENIED');
  expect(mock.prepare).not.toHaveBeenCalled(); expect(mock.execute).not.toHaveBeenCalled();
});

it('native-capable stream returns held admission once without executing or re-admitting', async () => {
  const held = {admitted: false, state: 'waiting_resume', executionId: id, blockedRequestId: id};
  mock.prepare.mockResolvedValue(held);
  const events = [];
  const stream = await app.createCaller(context).opc.mentorTurnStream({...input, purpose: 'mentor', textProtocol: 'textDelta-v1'});
  for await (const event of stream) events.push(event);
  expect(events).toEqual([{type: 'result', result: held}]);
  expect(mock.prepare).toHaveBeenCalledTimes(1); expect(mock.execute).not.toHaveBeenCalled();
  expect(mock.prepare.mock.calls[0]![0]).not.toHaveProperty('textProtocol');
});

it.each(['429', 'paused-503', 'unavailable-503', 'unknown'] as const)(
  'native-capable stream does not retry admission after %s', async failure => {
    mock.prepare.mockRejectedValue(failure === 'unknown' ? new Error('synthetic unknown result')
      : new RateLimitError(failure === '429' ? 'rate_limited' : 'unavailable', 60,
        failure === '429' ? 'minute' : failure === 'paused-503' ? 'paused' : 'limit_unavailable'));
    const stream = await app.createCaller(context).opc.mentorTurnStream({...input, purpose: 'mentor', textProtocol: 'textDelta-v1'});
    await expect((async () => { for await (const event of stream) { void event; } })()).rejects.toThrow();
    expect(mock.prepare).toHaveBeenCalledTimes(1); expect(mock.execute).not.toHaveBeenCalled();
  },
);
