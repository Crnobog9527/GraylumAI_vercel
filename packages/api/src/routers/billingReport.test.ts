/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { billingReportRouter } from './billingReport';

function harness(role: 'admin' | 'user' | 'anonymous', rpcResult: { data: unknown; error: unknown }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = {
    from(table: string) {
      if (table === 'system_settings') return { select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: null, error: null }) };
      if (table !== 'profiles') throw new Error(table);
      return { select() { return this; }, eq() { return this; },
        single: async () => ({ data: { id: 'actor', role, status: 'active', credits: 0, nickname: 'S', email: 's@example.test' }, error: null }) };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return rpcResult; },
  };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: 'actor', email: 's@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never;
  return { caller: billingReportRouter.createCaller(ctx), calls };
}

const reportData = {
  models: [{ model: 'v/a', calls: 2, unknownCostCalls: 0, nominalUsd: '0.004', actualUsd: '0.003', minMultiplier: '2', maxMultiplier: '3' }],
  byDate: [{ date: '2026-10-01', calls: 2, unknownCostCalls: 0, nominalUsd: '0.004' }],
  totals: { calls: 2, unknownCostCalls: 0, nominalUsd: '0.004', actualUsd: '0.003', turns: 1, chargedCredits: 1, absorbedCredits: 0, unsettledTurns: 0 },
};
const unsettledData = { total: 0, turns: [] };

describe('turn cost report endpoints', () => {
  it('reads a bounded window through the admin-only report function', async () => {
    const f = harness('admin', { data: reportData, error: null });
    const report = await f.caller.turnByModel({ days: 7 });
    expect(report).toMatchObject({ available: true, totals: { calls: 2, turns: 1 } });
    expect(f.calls[0]).toMatchObject({ fn: 'turn_admin_model_report' });
    const { p_from: from, p_to: to } = f.calls[0]!.args as { p_from: string; p_to: string };
    expect(Date.parse(to) - Date.parse(from)).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it('a missing function is reported as unavailable, never as an empty month', async () => {
    const f = harness('admin', { data: null, error: { code: 'PGRST202' } });
    expect(await f.caller.turnByModel({ days: 30 })).toMatchObject({ available: false });
    expect(await f.caller.unsettledTurns()).toMatchObject({ available: false });
  });
  it('lists unsettled turns through the read-only function', async () => {
    const f = harness('admin', { data: unsettledData, error: null });
    expect(await f.caller.unsettledTurns()).toEqual({ available: true, total: 0, turns: [] });
    expect(f.calls).toEqual([{ fn: 'turn_admin_unsettled_turns', args: { p_limit: 100 } }]);
  });
  it.each([0, 91, 1.5])('rejects a window of %s days', async (days) => {
    const f = harness('admin', { data: reportData, error: null });
    await expect(f.caller.turnByModel({ days })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.calls).toEqual([]);
  });
  it.each(['user', 'anonymous'] as const)('denies %s both views', async (role) => {
    const f = harness(role, { data: reportData, error: null });
    const code = role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN';
    await expect(f.caller.turnByModel({ days: 30 })).rejects.toMatchObject({ code });
    await expect(f.caller.unsettledTurns()).rejects.toMatchObject({ code });
    expect(f.calls).toEqual([]);
  });
});

describe('platform alert endpoint permissions', () => {
  it('allows administrators to read disabled reminders and missing configuration', async () => {
    const f = harness('admin', { data: [], error: null });
    expect(await f.caller.platformAbsorbConfig()).toBeNull();
    expect(await f.caller.platformAbsorbAlerts()).toEqual({ status: 'disabled', alerts: [] });
  });
  it.each(['user', 'anonymous'] as const)('denies every platform alert operation to %s', async (role) => {
    const f = harness(role, { data: [], error: null });
    const code = role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN';
    await expect(f.caller.platformAbsorbConfig()).rejects.toMatchObject({ code });
    await expect(f.caller.platformAbsorbAlerts()).rejects.toMatchObject({ code });
    await expect(f.caller.savePlatformAbsorbConfig({ defaultUsd: '1', models: {} })).rejects.toMatchObject({ code });
    await expect(f.caller.acknowledgePlatformAbsorb({ model: 'v/a', utcDate: '2026-10-01' })).rejects.toMatchObject({ code });
    expect(f.calls).toEqual([]);
  });
});

const callId = '11111111-1111-4111-8111-111111111111';
const auditId = '22222222-2222-4222-8222-222222222222';
const reviewInput = {
  callId, requestId: auditId,
  review: { expectedEvidenceHash: 'a'.repeat(64), profileVersion: 'profile-1', evidenceVersion: 'evidence-1',
    reviewReference: 'Approved synthetic profile revalidation', humanReviewed: true as const },
};
const reviewResult = { callId, auditId, reviewed: true };
const snapshot = { callId, evidenceHash: 'a'.repeat(64), profileVersion: 'profile-1', evidenceVersion: 'evidence-1',
  reviewable: true, budgetConflict: false, meteringMissing: true, meteringExit: false, auditId: null };

describe('manual metering review endpoints', () => {
  it('binds review actor to authenticated context and delegates atomic audit to SQL once', async () => {
    const f = harness('admin', { data: reviewResult, error: null });
    await expect(f.caller.reviewMetering(reviewInput)).resolves.toEqual(reviewResult);
    expect(f.calls).toEqual([{ fn: 'bill2_payg_review_metering', args: {
      p_actor_id: 'actor', p_call_id: callId, p_request_id: auditId, p_review: reviewInput.review,
    } }]);
  });
  it('reads only the requested call snapshot through the administrator RPC', async () => {
    const f = harness('admin', { data: snapshot, error: null });
    await expect(f.caller.meteringReviewSnapshot({ callId })).resolves.toEqual(snapshot);
    expect(f.calls).toEqual([{ fn: 'bill2_payg_metering_review_snapshot', args: { p_actor_id: 'actor', p_call_id: callId } }]);
  });
  it.each(['user', 'anonymous'] as const)('denies %s both read and write', async role => {
    const f = harness(role, { data: reviewResult, error: null });
    const code = role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN';
    await expect(f.caller.reviewMetering(reviewInput)).rejects.toMatchObject({ code });
    await expect(f.caller.meteringReviewSnapshot({ callId })).rejects.toMatchObject({ code });
    expect(f.calls).toEqual([]);
  });
  it.each([
    { ...reviewInput, actorId: 'forged' },
    { ...reviewInput, review: { ...reviewInput.review, humanReviewed: false } },
    { ...reviewInput, review: { ...reviewInput.review, reviewReference: ' ' } },
    { ...reviewInput, review: { ...reviewInput.review, expectedEvidenceHash: 'bad' } },
    { ...reviewInput, review: { ...reviewInput.review, profileVersion: '' } },
    { ...reviewInput, review: { ...reviewInput.review, resetConflict: true } },
  ])('rejects forged identity or incomplete human evidence %#', async input => {
    const f = harness('admin', { data: reviewResult, error: null });
    await expect(f.caller.reviewMetering(input as typeof reviewInput)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.calls).toEqual([]);
  });
  it.each([
    ['BILL2_METERING_REVIEW_DENIED', 'FORBIDDEN'],
    ['BILL2_METERING_REVIEW_CONFLICT', 'CONFLICT'],
    ['BILL2_METERING_REVIEW_NOT_READY', 'CONFLICT'],
  ])('maps %s without retry', async (message, code) => {
    const f = harness('admin', { data: null, error: { message, details: 'private database details' } });
    await expect(f.caller.reviewMetering(reviewInput)).rejects.toMatchObject({ code, message });
    expect(f.calls).toHaveLength(1);
  });
  it('does not expose arbitrary database error text', async () => {
    const f = harness('admin', { data: null, error: { message: 'private database details' } });
    await expect(f.caller.reviewMetering(reviewInput)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE', message: 'BILL2_METERING_REVIEW_UNAVAILABLE',
    });
  });
  it.each([null, { ...reviewResult, callId: auditId }, { ...reviewResult, reviewed: false },
    { ...reviewResult, extra: 'untrusted' }])('fails closed on invalid write result %#', async data => {
    const f = harness('admin', { data, error: null });
    await expect(f.caller.reviewMetering(reviewInput)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it.each([null, { ...snapshot, callId: auditId }, { ...snapshot, evidenceHash: 'bad' }])(
    'fails closed on invalid snapshot %#', async data => {
      const f = harness('admin', { data, error: null });
      await expect(f.caller.meteringReviewSnapshot({ callId })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    });
});
