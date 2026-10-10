/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { stagingProcedureError } from '../runtime/stagingErrors';
import { reportFinalizationService, reportEditInput } from './finalization';
const actor = randomUUID();
const executionId = randomUUID();
const user = (verified = true) => ({ auth: { getUser: async () => ({ data: {
  user: { id: actor, email_confirmed_at: verified ? '2026-01-01T00:00:00Z' : null },
} }) } }) as unknown as SupabaseClient;
function fixture(error: { message: string } | null = null) {
  const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: { revision: 1, manuallyEdited: true }, error }) }));
  return { rpc, admin: { rpc } as unknown as SupabaseClient };
}
it('uses the verified actor and exact revision; never admits a model run', async () => {
  const f = fixture();
  const requestId = randomUUID();
  const value = await reportFinalizationService(user(), f.admin).save({ executionId, requestId,
    expectedRevision: 0, body: '## 定位\n手动版本' });
  expect(value).toEqual({ revision: 1, manuallyEdited: true });
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('report_document', {
    p_actor_id: actor, p_execution_id: executionId, p_action: 'save', p_request_id: requestId,
    p_expected_revision: 0, p_body: '## 定位\n手动版本', p_expected_body_hash: null,
  });
});
it('read and finalize preserve server identity and displayed body hash', async () => {
  const f = fixture();
  const service = reportFinalizationService(user(), f.admin);
  await service.read({ executionId });
  expect(f.rpc.mock.calls[0]).toEqual(['report_document', expect.objectContaining({ p_action: 'read', p_request_id: null })]);
  await service.finalize({ executionId, requestId: randomUUID(), expectedRevision: 2, expectedBodyHash: 'a'.repeat(64) });
  expect(f.rpc.mock.calls[1]).toEqual(['report_document', expect.objectContaining({ p_action: 'finalize',
    p_expected_revision: 2, p_expected_body_hash: 'a'.repeat(64), p_body: null })]);
});
it('rejects unverified identity before any privileged call', async () => {
  const f = fixture();
  await expect(reportFinalizationService(user(false), f.admin).read({ executionId })).rejects.toMatchObject({
    code: 'FORBIDDEN', message: 'REPORT_AUTH_REQUIRED',
  });
  expect(f.rpc).not.toHaveBeenCalled();
});
it.each(['REPORT_NOT_COMPLETE', 'REPORT_BODY_INVALID', 'REPORT_VERSION_CONFLICT', 'REPORT_REQUEST_CONFLICT',
  'REPORT_ALREADY_FINALIZED', 'CONTENT_ERASED', 'REPORT_SOURCE_CONFLICT'])(
  'preserves stable database refusal %s', async message => {
    const f = fixture({ message });
    await expect(reportFinalizationService(user(), f.admin).read({ executionId })).rejects.toMatchObject({ message });
  });
it('does not expose internal database errors', async () => {
  const f = fixture({ message: 'private database detail' });
  await expect(reportFinalizationService(user(), f.admin).read({ executionId })).rejects.toMatchObject({
    message: 'REPORT_UNAVAILABLE', code: 'SERVICE_UNAVAILABLE',
  });
});
it('validates unicode size, forbids forged actor and invalid revisions', () => {
  const input = { executionId, requestId: randomUUID(), expectedRevision: 0, body: '😀'.repeat(12000) };
  expect(reportEditInput.safeParse(input).success).toBe(true);
  for (const change of [{ body: '😀'.repeat(12001) }, { actorId: randomUUID() }, { expectedRevision: -1 }]) {
    expect(reportEditInput.safeParse({ ...input, ...change }).success).toBe(false);
  }
});

it('keeps its safe error code through the Runtime maintenance error boundary', async () => {
  const f = fixture({ message: 'private database error' });
  try {
    await reportFinalizationService(user(), f.admin).read({ executionId });
    throw new Error('expected refusal');
  } catch (error) {
    expect(stagingProcedureError(error, 'runtime.reportDocument')).toMatchObject({
      code: 'SERVICE_UNAVAILABLE', message: 'REPORT_UNAVAILABLE',
    });
  }
});
