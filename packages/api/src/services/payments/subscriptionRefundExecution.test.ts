/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { planMonthlyRefundStep, type MonthlyRefundIntent } from './subscriptionRefundExecution';
import { monthlyRefundVersion } from './monthlyRefundApproval';
import { now, executionFixture, claimedFixture, stoppedFixture, refundFixture } from './__tests__/monthlyRefundExecutionFixture';

type Fixture = ReturnType<typeof executionFixture>;
const run = (f: Fixture, at = now) => planMonthlyRefundStep(f.intent, f.seen, at);
const record = (f: Fixture) => {
  const refund = f.seen.refunds.rows[0]!;
  f.intent.recordedRefund = { id: refund.id, status: refund.status };
};
const refreshVersion = (f: Fixture) => {
  f.intent.versionHash = monthlyRefundVersion(f.intent.terms);
  f.seen.local.approvalVersion = f.intent.versionHash;
};

describe('non-executing monthly refund progression', () => {
  it('requests an atomic claim, never approval or provider dispatch', () => {
    const f = executionFixture();
    expect(run(f)).toEqual({ kind: 'claim', versionHash: f.intent.versionHash, executable: false });
  });
  it('requires persistence before every provider boundary and preserves exact refund parameters', () => {
    const f = claimedFixture();
    expect(run(f)).toMatchObject({ kind: 'record_before_dispatch', stage: 'stop_renewal', executable: false });
    f.intent.started.stop_renewal = now;
    expect(run(f)).toMatchObject({ kind: 'provider_request', stage: 'stop_renewal',
      parameters: { cancel_at_period_end: true }, executable: false });
    f.seen.subscription.cancelAtPeriodEnd = true; f.seen.subscription.renewalOwnership = 'intent';
    expect(run(f)).toMatchObject({ kind: 'record_before_dispatch', stage: 'refund' });
    f.intent.started.refund = now;
    const first = run(f);
    expect(first).toMatchObject({ kind: 'provider_request', stage: 'refund', operation: 'create_refund',
      objectId: 'ch_fixture', parameters: { charge: 'ch_fixture', amount: 6486,
        metadata: { orderId: 'order-fixture', refundIntentId: f.intent.id } } });
    expect(run(f)).toEqual(first);
    const keys = Object.keys(f.intent);
    expect(keys).not.toContain('newIntentId');
  });
  it('does not issue a renewal update when the original contract was already stopping', () => {
    const f = claimedFixture(); f.intent.terms.originalCancelAtPeriodEnd = true;
    f.seen.subscription.cancelAtPeriodEnd = true; refreshVersion(f);
    expect(run(f)).toMatchObject({ kind: 'record_before_dispatch', stage: 'refund' });
  });
  it('records cash first, cancels without proration, then finalizes from authoritative cancellation', () => {
    const f = refundFixture();
    expect(run(f)).toMatchObject({ kind: 'record_refund', status: 'succeeded' });
    record(f);
    expect(run(f)).toMatchObject({ kind: 'record_before_dispatch', stage: 'cancel' });
    f.intent.started.cancel = now;
    const result = run(f);
    expect(result).toEqual({ kind: 'provider_request', stage: 'cancel', operation: 'cancel_subscription',
      objectId: 'sub_fixture', parameters: { invoice_now: false, prorate: false }, executable: false });
    expect(result).not.toHaveProperty('idempotencyKey');
    f.seen.subscription.status = 'canceled';
    expect(run(f)).toMatchObject({ kind: 'finalize_success', refundId: 're_fixture', executable: false });
  });
  it.each(['pending', 'requires_action'] as const)('records %s without releasing or prematurely canceling', status => {
    const f = refundFixture(status);
    expect(run(f)).toMatchObject({ kind: 'record_refund', status }); record(f);
    expect(run(f)).toMatchObject({ kind: 'pending', refundId: 're_fixture' });
    f.seen.subscription.cancelAtPeriodEnd = false;
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'pending_refund_renewal_changed' });
  });
  it.each(['failed', 'canceled'] as const)('restores only owned renewal stop after confirmed %s, then releases', status => {
    const f = refundFixture(status); record(f);
    expect(run(f)).toMatchObject({ kind: 'record_before_dispatch', stage: 'restore_renewal' });
    f.intent.started.restore_renewal = now;
    expect(run(f)).toMatchObject({ kind: 'provider_request', stage: 'restore_renewal',
      parameters: { cancel_at_period_end: false } });
    f.seen.subscription.cancelAtPeriodEnd = false;
    expect(run(f)).toMatchObject({ kind: 'release_failed_reservation', refundId: 're_fixture' });
  });
  it('never restores a cancellation that predated this refund intent', () => {
    const f = refundFixture('failed'); record(f);
    f.intent.terms.originalCancelAtPeriodEnd = true; f.intent.started.stop_renewal = null;
    f.seen.subscription.renewalOwnership = 'original'; refreshVersion(f);
    expect(run(f)).toMatchObject({ kind: 'release_failed_reservation' });
    f.seen.subscription.cancelAtPeriodEnd = false;
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'renewal_state_changed' });
  });
  it('does not release credits on missing or incomplete cash result', () => {
    const f = stoppedFixture(); f.intent.started.refund = now;
    f.seen.refunds.complete = false;
    expect(run(f)).toMatchObject({ kind: 'review_required' });
    f.seen.refunds.complete = true;
    f.seen.local.eligibility = 'unknown';
    expect(run(f)).toMatchObject({ kind: 'review_required' });
  });
  it('requires readback rather than re-refunding after cash success and cancel uncertainty', () => {
    const f = refundFixture(); record(f); f.intent.started.cancel = now;
    f.seen.subscription.status = 'unknown';
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'cash_succeeded_subscription_unresolved' });
  });
  it('keeps already happened cash facts when local eligibility or account changed', () => {
    const f = refundFixture(); f.seen.local.account = 'closed'; f.seen.local.eligibility = 'unknown';
    f.seen.subscription.preflight = 'conflict';
    expect(run(f)).toMatchObject({ kind: 'record_refund', status: 'succeeded' }); record(f);
    expect(run(f)).toMatchObject({ kind: 'review_required' });
    f.seen.subscription.status = 'canceled';
    expect(run(f)).toMatchObject({ kind: 'finalize_success' });
  });
  it('refuses new sends after closure without making a new identity', () => {
    const f = stoppedFixture(); f.seen.local.account = 'closed';
    expect(run(f)).toMatchObject({ kind: 'review_required' });
    expect(f.intent.started.refund).toBeNull();
  });
  it.each([
    ['2026-10-08T07:59:59.999999Z', 'provider_request'],
    ['2026-10-08T08:00:00Z', 'review_required'],
    ['2026-10-08T12:00:00Z', 'review_required'],
  ])('keeps original POST identity/window at %s', (at, kind) => {
    const f = stoppedFixture(); f.intent.started.refund = now; f.seen.checkedAt = at;
    expect(run(f, at).kind).toBe(kind);
    expect(f.intent.claimedAt).toBe(now); expect(f.intent.started.refund).toBe(now);
  });
  it('does not extend the cash window by first entering the refund stage later', () => {
    const f = stoppedFixture(); const at = '2026-10-08T08:00:00Z'; f.seen.checkedAt = at;
    expect(run(f, at)).toMatchObject({ kind: 'review_required', reason: 'post_retry_window_elapsed' });
    f.intent.started.refund = at;
    expect(run(f, at)).toMatchObject({ kind: 'review_required', reason: 'post_retry_window_elapsed' });
  });
  it('can reconcile an existing successful refund after the POST retry window', () => {
    const f = refundFixture(); const at = '2026-10-10T00:00:00Z'; f.seen.checkedAt = at;
    expect(run(f, at)).toMatchObject({ kind: 'record_refund' });
  });
  it('returns identical plan for concurrent readers without mutating durable input', () => {
    const f = stoppedFixture(); const before = structuredClone(f);
    expect(run(f)).toEqual(run(f)); expect(f).toEqual(before);
    // This is pure decision determinism, not DB concurrency or exactly-once proof.
    expect(run(f).executable).toBe(false);
  });
});

describe('identity, lifecycle and missing-evidence refusal', () => {
  const edits: Array<[string, (f: Fixture) => void]> = [
    ['nonadmin', f => { f.seen.local.adminActive = false; }],
    ['unknown account', f => { f.seen.local.account = 'unknown'; }],
    ['violation', f => { f.seen.local.account = 'violation_terminated'; }],
    ['lost reservation', f => { f.seen.local.hold = 'unknown'; }],
    ['stale approval', f => { f.seen.local.approvalVersion = 'different'; }],
    ['changed amount', f => { f.intent.terms.netMinor += 1; refreshVersion(f); }],
    ['changed credits', f => { f.intent.terms.credits -= 1; refreshVersion(f); }],
    ['wrong merchant', f => { f.seen.merchant = 'other'; }],
    ['live mode', f => { f.seen.mode = 'live'; }],
    ['wrong subscription', f => { f.seen.subscription.id = 'other'; }],
    ['period drift', f => { f.seen.subscription.periodEnd = '2026-11-02T00:00:00Z'; }],
    ['unknown preflight', f => { f.seen.subscription.preflight = 'unknown'; }],
    ['other unpaid invoice', f => { f.seen.subscription.preflight = 'conflict'; }],
    ['consumed after approval', f => { f.seen.local.eligibility = 'changed'; }],
    ['truncated refund lookup', f => { f.seen.refunds.complete = false; }],
    ['renewal stop not owned', f => { f.seen.subscription.renewalOwnership = 'unknown'; }],
    ['future claim', f => { f.intent.claimedAt = '2026-10-08T12:00:00Z'; }],
    ['future write marker', f => { f.intent.started.refund = '2026-10-08T12:00:00Z'; }],
    ['dispatch before claim', f => { f.intent.started.refund = '2026-10-06T12:00:00Z'; }],
    ['cancel without cash attempt', f => { f.intent.started.cancel = now; }],
    ['annual scope', f => { f.intent.terms.snapshot.billing_cycle = 'yearly'; refreshVersion(f); }],
    ['late application', f => { f.intent.terms.submittedAt = '2026-10-08T00:00:00.000001Z'; refreshVersion(f); }],
  ];
  it.each(edits)('refuses %s', (_, change) => {
    const f = stoppedFixture(); change(f);
    expect(run(f)).toMatchObject({ kind: 'review_required', executable: false });
  });
  const refundEdits: Array<[string, (f: Fixture) => void]> = [
    ['other intent', f => { f.seen.refunds.rows[0]!.intentId = 'other'; }],
    ['other order', f => { f.seen.refunds.rows[0]!.orderId = 'other'; }],
    ['other charge', f => { f.seen.refunds.rows[0]!.chargeId = 'other'; }],
    ['other payment', f => { f.seen.refunds.rows[0]!.paymentIntentId = 'other'; }],
    ['other currency', f => { f.seen.refunds.rows[0]!.currency = 'eur'; }],
    ['other amount', f => { f.seen.refunds.rows[0]!.amount++; }],
    ['other merchant', f => { f.seen.refunds.rows[0]!.merchant = 'other'; }],
    ['other mode', f => { f.seen.refunds.rows[0]!.mode = 'live'; }],
    ['multiple refunds', f => { f.seen.refunds.rows.push({ ...f.seen.refunds.rows[0]!, id: 're_other' }); }],
    ['missing request identity', f => { f.intent.started.refund = null; }],
  ];
  it.each(refundEdits)('does not adopt %s', (_, change) => {
    const f = refundFixture(); change(f);
    expect(run(f)).toMatchObject({ kind: 'review_required' });
  });
  it.each(['succeeded', 'failed', 'canceled'] as const)('does not overwrite %s with a late conflicting outcome', status => {
    const f = refundFixture(status); record(f);
    f.seen.refunds.rows[0]!.status = status === 'succeeded' ? 'failed' : 'succeeded';
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'terminal_refund_conflict' });
  });
  it('does not forget a persisted refund because the latest list omitted it', () => {
    const f = refundFixture(); record(f); f.seen.refunds.rows = [];
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'recorded_refund_missing_or_changed' });
  });
  it.each(['unknown', 'original'] as const)('does not restore renewal without intent ownership: %s', renewalOwnership => {
    const f = refundFixture('failed'); record(f); f.seen.subscription.renewalOwnership = renewalOwnership;
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'renewal_restore_requires_review' });
  });
  it('does not restore after the subscription was canceled externally', () => {
    const f = refundFixture('failed'); record(f); f.seen.subscription.status = 'canceled';
    expect(run(f)).toMatchObject({ kind: 'review_required' });
  });
  it('does not rewind to stopping renewal after a cash attempt', () => {
    const f = stoppedFixture(); f.intent.started.refund = now; f.seen.subscription.cancelAtPeriodEnd = false;
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'renewal_stop_changed' });
  });
  it.each([null, {}, { terms: null }, { started: { refund: now } }])('rejects missing or scrubbed intent %j', intent => {
    expect(planMonthlyRefundStep(intent, executionFixture().seen, now)).toMatchObject({ kind: 'review_required' });
  });
  it('rejects unknown fields rather than persisting private text', () => {
    const f = executionFixture();
    expect(planMonthlyRefundStep({ ...f.intent, privateText: 'PRIVATE_CANARY' }, f.seen, now))
      .toEqual({ kind: 'review_required', reason: 'invalid_or_missing_evidence', executable: false });
  });
  it.each(['2026-10-07T11:58:59Z', '2026-10-07T12:00:01Z'])('requires fresh non-future observations %s', checkedAt => {
    const f = stoppedFixture(); f.seen.checkedAt = checkedAt;
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'fresh_observation_required' });
  });
  it.each([
    ['failed', 'cancel'], ['canceled', 'cancel'], ['pending', 'cancel'],
    ['succeeded', 'restore_renewal'], ['pending', 'restore_renewal'],
  ] as const)('rejects %s cash with an already started %s stage', (status, stage) => {
    const f = refundFixture(status); record(f); f.intent.started[stage] = now;
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'stage_outcome_conflict' });
  });
  it.each(['cancel', 'restore_renewal'] as const)('requires persisted cash outcome before %s', stage => {
    const f = refundFixture(stage === 'cancel' ? 'succeeded' : 'failed'); f.intent.started[stage] = now;
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'stage_outcome_conflict' });
  });
  it('rejects inconsistent cancel and restoration stages', () => {
    const f = refundFixture(); f.intent.started.cancel = now; f.intent.started.restore_renewal = now;
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'stage_order_invalid' });
  });
  it('never accepts changed terms without a new independent approval', () => {
    const f = stoppedFixture(); f.intent.terms.feeEvidence = 'different';
    expect(run(f)).toMatchObject({ kind: 'review_required', reason: 'approval_changed' });
  });
  it('does not allow an unclaimed record to imply prior dispatch', () => {
    const f = executionFixture(); f.intent.started.refund = now;
    expect(run(f)).toMatchObject({ kind: 'review_required' });
  });
  it('only emits false executable even for every successful phase', () => {
    const fixtures = [executionFixture(), claimedFixture(), stoppedFixture(), refundFixture()];
    for (const f of fixtures) expect(run(f).executable).toBe(false);
    const durable: MonthlyRefundIntent = structuredClone(fixtures[0]!.intent);
    expect(durable.claimedAt).toBeNull();
  });
});
