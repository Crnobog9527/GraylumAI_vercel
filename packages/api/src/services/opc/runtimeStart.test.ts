/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runtimeStart } from './runtimeStart';
import { readRuntimeSessionScope } from './runtimeSessionScope';

const actor = '10000000-0000-4000-8000-000000000001';
const request = '10000000-0000-4000-8000-000000000002';
const user = (verified = true) => ({ auth: { getUser: async () => ({ data: { user: { id: actor, ...(verified ? { email_confirmed_at: '2026-01-01' } : {}) } }, error: null }) } }) as unknown as SupabaseClient;
const admin = (result: { data?: unknown; error?: { code?: string; message: string } | null }) => {
  const rpc = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
};

describe('runtime.start (a conversation opens for the verified user)', () => {
  it('opens a positioning conversation or a work-item conversation for the signed-in actor only', async () => {
    const a = admin({ data: { sessionId: actor } });
    await expect(runtimeStart(user(), a.client, request, { kind: 'positioning_draft' })).resolves.toEqual({ sessionId: actor });
    expect(a.rpc).toHaveBeenCalledWith('runtime_start', { p_request_id: request, p_payload: { scope: { kind: 'positioning_draft' } }, p_actor_id: actor });
    const work = { kind: 'work_item', projectId: request, workItemId: request };
    await runtimeStart(user(), a.client, request, work);
    expect(a.rpc).toHaveBeenLastCalledWith('runtime_start', { p_request_id: request, p_payload: { scope: work }, p_actor_id: actor });
  });

  it('refuses an unverified account and any other scope before the database is touched', async () => {
    const a = admin({ data: {} });
    await expect(runtimeStart(user(false), a.client, request, { kind: 'positioning_draft' })).rejects.toThrow('RUNTIME_AUTH_REQUIRED');
    await expect(runtimeStart(user(), a.client, request, { kind: 'anything' })).rejects.toThrow();
    await expect(runtimeStart(user(), a.client, request, { kind: 'positioning_draft', extra: 1 })).rejects.toThrow();
    await expect(runtimeStart(user(), a.client, 'not-a-uuid', { kind: 'positioning_draft' })).rejects.toThrow();
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it('keeps the business refusals and hides database detail', async () => {
    await expect(runtimeStart(user(), admin({ error: { code: 'P0001', message: 'OPC_BUSINESS_ARCHIVED' } }).client, request, { kind: 'positioning_draft' }))
      .rejects.toThrow('OPC_BUSINESS_ARCHIVED');
    await expect(runtimeStart(user(), admin({ error: { code: 'P0001', message: 'OPC_CONTENT_BINDING' } }).client, request, { kind: 'positioning_draft' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'OPC_CONTENT_BINDING' });
    await expect(runtimeStart(user(), admin({ error: { code: 'P0001', message: 'SYNTHETIC_PRIVATE_DETAIL' } }).client, request, { kind: 'positioning_draft' }))
      .rejects.toThrow('RUNTIME_ADMISSION_DENIED');
  });
});

describe('runtime.view (scope only)', () => {
  const read = (result: Parameters<typeof admin>[0]) => readRuntimeSessionScope(admin(result).client, actor, request);

  it('returns the session, its scope and whether it is an older conversation', async () => {
    await expect(read({ data: { sessionId: request, scope: { kind: 'positioning_draft' }, legacy: false } }))
      .resolves.toEqual({ sessionId: request, scope: { kind: 'positioning_draft' }, legacy: false });
    await expect(read({ data: { sessionId: request, scope: { kind: 'work_item', projectId: request, workItemId: request }, legacy: true } }))
      .resolves.toMatchObject({ scope: { kind: 'work_item', workItemId: request }, legacy: true });
  });

  it('answers a foreign or missing session as not found, erased content as erased, anything unreadable as denied', async () => {
    await expect(read({ error: { code: 'P0001', message: 'RUNTIME_SCOPE_DENIED' } })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'RUNTIME_SESSION_NOT_FOUND' });
    await expect(read({ error: { code: 'P0001', message: 'CONTENT_ERASED' } })).rejects.toBeDefined();
    await expect(read({ error: { code: 'XX000', message: 'boom' } })).rejects.toThrow('RUNTIME_VIEW_DENIED');
    await expect(read({ data: { sessionId: actor, scope: { kind: 'positioning_draft' }, legacy: false } })).rejects.toThrow('RUNTIME_VIEW_DENIED');
    await expect(read({ data: { sessionId: request, scope: { kind: 'other' }, legacy: false } })).rejects.toThrow('RUNTIME_VIEW_DENIED');
    await expect(read({ data: { sessionId: request, scope: { kind: 'positioning_draft' }, legacy: false, executions: [] } })).rejects.toThrow('RUNTIME_VIEW_DENIED');
  });
});
