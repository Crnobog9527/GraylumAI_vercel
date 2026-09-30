/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { readMembershipEntitlements, assertFusionEntitlement } from './membershipEntitlements';
import { actorId, fixture, subscription } from './__tests__/entitlementsFixture';

describe('new-action membership entitlements', () => {
  it.each([
    ['free', false, 50_000_000], ['pro', true, 500_000_000], ['gold', true, 2_000_000_000],
  ] as const)('reads %s defaults and enforces both modes', async (level, allowed, bytes) => {
    const f = fixture(level);
    const result = await readMembershipEntitlements(f.client, actorId);
    expect(result).toMatchObject({ level, libraryStorageBytes: bytes, fusionCompareMaxModels: 4 });
    for (const mode of ['review', 'compare'] as const) {
      const run = () => assertFusionEntitlement(result, mode, 4);
      if (allowed) expect(run).not.toThrow();
      else expect(run).toThrow('ENTITLEMENTS_FUSION_FORBIDDEN');
    }
    expect(f.writes).toEqual([]);
  });
  it('uses current admin configuration independently, including free and off-sale plans', async () => {
    const f = fixture('free');
    Object.assign(f.rows.membership_plans![0]!, { allow_fusion_review: true, is_active: 'false', library_storage_bytes: 123 });
    const result = await readMembershipEntitlements(f.client, actorId);
    expect(result.libraryStorageBytes).toBe(123);
    expect(() => assertFusionEntitlement(result, 'review', 20)).not.toThrow();
    expect(() => assertFusionEntitlement(result, 'compare', 2)).toThrow('ENTITLEMENTS_FUSION_FORBIDDEN');
  });
  it('allows a paid active subscription even when checkout eligibility would reject buying it again', async () => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription()];
    const result = await readMembershipEntitlements(f.client, actorId);
    expect(result.state).toBe('active');
    expect(() => assertFusionEntitlement(result, 'compare', 4)).not.toThrow();
    expect(() => assertFusionEntitlement(result, 'compare', 5)).toThrow('ENTITLEMENTS_COMPARE_MODEL_LIMIT');
    f.rows.system_settings![0]!.value = 8;
    const updated = await readMembershipEntitlements(f.client, actorId);
    expect(() => assertFusionEntitlement(updated, 'compare', 8)).not.toThrow();
    for (const count of [0, 1, 2.1, 9, NaN, Infinity]) {
      expect(() => assertFusionEntitlement(updated, 'compare', count)).toThrow('ENTITLEMENTS_COMPARE_MODEL_LIMIT');
    }
    expect(() => assertFusionEntitlement(updated, 'review', 20)).not.toThrow();
  });
  it.each(['past_due', 'incomplete', 'unpaid', 'paused', 'unknown', 'canceled', 'incomplete_expired'])
  ('does not grant new paid features for %s', async status => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription(status)];
    const result = await readMembershipEntitlements(f.client, actorId);
    expect(result).toMatchObject({ level: 'free', libraryStorageBytes: 50_000_000, allowFusionReview: false });
    expect(() => assertFusionEntitlement(result, 'compare', 2)).toThrow('ENTITLEMENTS_FUSION_FORBIDDEN');
    expect(f.writes).toEqual([]);
  });
  it.each([null, 'invalid', '2020-01-01T00:00:00Z'])('fails paid admission at missing/expired end %s', async end => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription('active', end)];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'free', allowFusionCompare: false });
  });
  it.each(['pending', 'refunded', 'partially_refunded', 'unknown'])('fails closed on order %s', async status => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription()];
    f.rows.payment_orders = [{ user_id: actorId, item_type: 'membership_plan', status, payment_status: null, metadata: {} }];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'free', state: 'payment_attention' });
    f.rows.payment_orders[0]!.status = 'completed';
    f.rows.payment_orders[0]!.payment_status = 'paid';
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'pro', state: 'active' });
  });
  it('honors refund reviewRequired on an otherwise completed order', async () => {
    const f = fixture();
    f.rows.payment_orders = [{ user_id: actorId, item_type: 'membership_plan', status: 'completed', payment_status: 'paid',
      metadata: { refundReconciliation: { reviewRequired: true } } }];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'free', state: 'payment_attention' });
  });
  it('does not mistake an order without a subscription for an admin grant', async () => {
    const f = fixture();
    f.rows.payment_orders = [{ user_id: actorId, item_type: 'membership_plan', status: 'completed', payment_status: 'paid', metadata: {} }];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'free', state: 'inconsistent' });
  });
  it('preserves explicit admin grants and paid cancel-at-period-end until the actual end', async () => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription('admin_override', null)];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'pro', state: 'admin_override' });
    f.rows.user_subscriptions = [{ ...subscription(), cancel_at_period_end: 'true' }];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'pro', state: 'active' });
    f.rows.user_subscriptions[0]!.current_period_end = '2026-09-30T00:00:00Z';
    expect(await readMembershipEntitlements(f.client, actorId, Date.parse('2026-09-30T00:00:00Z')))
      .toMatchObject({ level: 'free', state: 'expired' });
  });
  it('allows the current paid subscription after an older manual grant or canceled subscription', async () => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription('admin_override', null), subscription('canceled'), subscription()];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'pro', state: 'active' });
  });
  it('does not choose between conflicting current subscriptions or mismatched plans', async () => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription(), subscription('trialing')];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'free', state: 'inconsistent' });
    f.rows.user_subscriptions = [{ ...subscription(), membership_plan_id: 'other-plan' }];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'free', state: 'inconsistent' });
  });
  it('new reads see downgrade and edits, previous values remain unchanged (consumer integration still required)', async () => {
    const f = fixture();
    const old = await readMembershipEntitlements(f.client, actorId);
    f.rows.profiles![0]!.membership_level = 'free';
    f.rows.membership_plans![1]!.allow_fusion_review = false;
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'free', allowFusionReview: false });
    expect(old).toMatchObject({ level: 'pro', allowFusionReview: true });
    expect(Object.isFrozen(old)).toBe(true);
    expect(f.writes).toEqual([]);
  });
  it.each(['profiles', 'membership_plans', 'user_subscriptions', 'payment_orders', 'system_settings'])
  ('does not turn %s read failure into a default allowance', async table => {
    const f = fixture(); f.failures.add(table);
    await expect(readMembershipEntitlements(f.client, actorId)).rejects.toMatchObject({ message: 'ENTITLEMENTS_UNAVAILABLE' });
  });
  it.each(['missing', 'duplicate', 'unknown', 'bad-type', 'overflow', 'bad-d3'])('rejects %s configuration', async scenario => {
    const f = fixture();
    if (scenario === 'missing') f.rows.membership_plans = [];
    if (scenario === 'duplicate') f.rows.membership_plans!.push({ ...f.rows.membership_plans![1]! });
    if (scenario === 'unknown') f.rows.profiles![0]!.membership_level = 'vip';
    if (scenario === 'bad-type') f.rows.membership_plans![1]!.allow_fusion_review = 'true';
    if (scenario === 'overflow') f.rows.membership_plans![1]!.library_storage_bytes = Number.MAX_SAFE_INTEGER + 1;
    if (scenario === 'bad-d3') f.rows.system_settings![0]!.value = 9;
    await expect(readMembershipEntitlements(f.client, actorId)).rejects.toMatchObject({ message: 'ENTITLEMENTS_UNAVAILABLE' });
  });
});
