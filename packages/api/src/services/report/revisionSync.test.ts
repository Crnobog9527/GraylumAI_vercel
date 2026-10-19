/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reportRevisionService, revisionApplyInput, revisionProposeInput } from './revisionSync';
const actor = randomUUID(), draftId = randomUUID(), revisionId = randomUUID(), sourceVersionId = randomUUID();
const user = (verified = true) => ({ auth: { getUser: async () => ({ data: {
  user: { id: actor, email_confirmed_at: verified ? '2026-01-01T00:00:00Z' : null },
} }) } }) as unknown as SupabaseClient;
function fixture(error: { message: string } | null = null, data: unknown = { revisionId, decision: null }) {
  const rpc = vi.fn(() => ({ abortSignal: async () => ({ data, error }) }));
  return { rpc, admin: { rpc } as unknown as SupabaseClient };
}
const proposal = { draftId, requestId: randomUUID(), sourceVersionId, body: '## One\n修订稿', fields: { a: { who: '忙碌的家长' } } };

it('proposes with the verified actor and the revision\'s own field values; no model or billing call', async () => {
  const f = fixture();
  await reportRevisionService(user(), f.admin).propose(proposal);
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('report_revision', {
    p_actor_id: actor, p_draft_id: draftId, p_action: 'propose', p_request_id: proposal.requestId, p_revision_id: null,
    p_source_version_id: sourceVersionId, p_body: proposal.body, p_fields: proposal.fields, p_expected_diff_hash: null,
  });
});
it('applies only with the diff hash the user saw, and declines without one', async () => {
  const f = fixture();
  const service = reportRevisionService(user(), f.admin);
  const requestId = randomUUID();
  await service.apply({ draftId, revisionId, requestId, expectedDiffHash: 'c'.repeat(64) });
  expect(f.rpc.mock.calls[0]).toEqual(['report_revision', expect.objectContaining({ p_action: 'apply',
    p_revision_id: revisionId, p_request_id: requestId, p_expected_diff_hash: 'c'.repeat(64), p_body: null, p_fields: null })]);
  await service.decline({ draftId, revisionId, requestId: randomUUID() });
  expect(f.rpc.mock.calls[1]).toEqual(['report_revision', expect.objectContaining({ p_action: 'decline', p_expected_diff_hash: null })]);
  expect(revisionApplyInput.safeParse({ draftId, revisionId, requestId }).success).toBe(false);
});
it('latest returns null when no revision exists', async () => {
  const f = fixture(null, null);
  expect(await reportRevisionService(user(), f.admin).latest({ draftId, sourceVersionId })).toBeNull();
});
it('rejects unverified identity before any privileged call', async () => {
  const f = fixture();
  await expect(reportRevisionService(user(false), f.admin).read({ draftId, revisionId })).rejects.toMatchObject({
    code: 'FORBIDDEN', message: 'REPORT_AUTH_REQUIRED' });
  expect(f.rpc).not.toHaveBeenCalled();
});
it.each([['REPORT_REVISION_STALE', 'CONFLICT'], ['REPORT_REVISION_DECIDED', 'CONFLICT'], ['REPORT_REVISION_INVALID', 'BAD_REQUEST'],
  ['REPORT_NOT_COMPLETE', 'BAD_REQUEST'], ['REPORT_REVISION_DENIED', 'FORBIDDEN'], ['CONTENT_ERASED', 'FORBIDDEN'],
  ['REPORT_SOURCE_CONFLICT', 'CONFLICT'], ['REPORT_REQUEST_CONFLICT', 'CONFLICT'], ['REPORT_REVISION_UNSUPPORTED', 'BAD_REQUEST']])(
  'preserves stable database refusal %s', async (message, code) => {
    const f = fixture({ message });
    await expect(reportRevisionService(user(), f.admin).read({ draftId, revisionId })).rejects.toMatchObject({ message, code });
  });
it('does not expose internal database errors', async () => {
  const f = fixture({ message: 'private database detail' });
  await expect(reportRevisionService(user(), f.admin).read({ draftId, revisionId })).rejects.toMatchObject({
    message: 'REPORT_UNAVAILABLE', code: 'SERVICE_UNAVAILABLE' });
});
it('validates sizes and forbids a forged actor', () => {
  expect(revisionProposeInput.safeParse({ ...proposal, body: '😀'.repeat(12000) }).success).toBe(true);
  // The strategy data block is not report text (REPORT-VISUAL): a body whose text fits is accepted with a long block, and the
  // limit still applies to the text itself (staging 2026-10-19: adopting a review revision failed with a 500 on this).
  const block = '```graylum-report-data\n' + JSON.stringify({ v: 1, field: 'summary', value: '数'.repeat(11000) }) + '\n```';
  expect(revisionProposeInput.safeParse({ ...proposal, body: `${'😀'.repeat(5000)}\n\n${block}` }).success).toBe(true);
  expect(revisionProposeInput.safeParse({ ...proposal, body: `${'😀'.repeat(12001)}\n\n${block}` }).success).toBe(false);
  // The whole body is capped as well, like a saved report (120000): a huge block is refused, a large legal one accepted (the metric is the saved report's: UTF-16 units).
  const huge = '```graylum-report-data\n' + JSON.stringify({ v: 1, field: 'summary', value: '数'.repeat(130000) }) + '\n```';
  expect(revisionProposeInput.safeParse({ ...proposal, body: `修订稿\n\n${huge}` }).success).toBe(false);
  const largest = '```graylum-report-data\n' + '数'.repeat(90000) + '\n```';
  expect(revisionProposeInput.safeParse({ ...proposal, body: `${'😀'.repeat(12000)}\n\n${largest}` }).success).toBe(true);
  expect(revisionProposeInput.safeParse({ ...proposal, fields: { a: { who: '😀'.repeat(400) } } }).success).toBe(true);
  for (const change of [{ body: '😀'.repeat(12001) }, { actorId: randomUUID() }, { fields: { a: { who: 'x'.repeat(401) } } },
    { fields: { a: { who: '' } } }, { fields: { a: { who: 1 } } }]) {
    expect(revisionProposeInput.safeParse({ ...proposal, ...change }).success).toBe(false);
  }
});
