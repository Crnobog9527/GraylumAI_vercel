/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reportService } from './service';
const id = randomUUID();
const input = { sessionId: id, projectId: id, roundId: id, requestId: id };
const user = { auth: { getUser: async () => ({ data: { user: { id, email_confirmed_at: '2026-01-01T00:00:00Z' } } }) } };
const policy = { account: 'synthetic', costPerCall: '0.1', creditsPerUsd: '100', multiplier: '6',
  maxCalls: 1, maxOutputTokens: 8192, inputBytes: 196608, historyItems: 0 };
it.each([null, { enabled: false }, { enabled: 'true' }, { enabled: true, extra: true }, 'invalid'])(
  'default-off flag rejects before membership, source, or billing (%j)', async value => {
    const rpc = vi.fn();
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: value === null ? null : { value }, error: null }) };
    const admin = { from: () => query, rpc } as unknown as SupabaseClient;
    await expect(reportService(user as unknown as SupabaseClient, admin, policy).start(input)).rejects.toThrow('REPORT_DISABLED');
    expect(rpc).not.toHaveBeenCalled();
  });
it('free member is rejected before creating a report run or reading facts', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'REPORT_MEMBERSHIP_REQUIRED' } }));
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { value: { enabled: true } }, error: null }) };
  const admin = { from: () => query, rpc } as unknown as SupabaseClient;
  await expect(reportService(user as unknown as SupabaseClient, admin, policy).start(input)).rejects.toMatchObject({
    code: 'FORBIDDEN', message: 'REPORT_MEMBERSHIP_REQUIRED',
  });
  expect(rpc.mock.calls).toHaveLength(1);
  expect((rpc.mock.calls as unknown[][])[0]![0]).toBe('report_membership_check');
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
