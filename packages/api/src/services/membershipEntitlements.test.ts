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
  it.each(['past_due', 'incomplete', 'unpaid'])('denies new paid features for subscription %s', async status => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription(status)];
    const result = await readMembershipEntitlements(f.client, actorId);
    expect(result).toMatchObject({ level: 'free', state: 'payment_attention', reasonCode: 'PAYMENT_ATTENTION_REQUIRED',
      safeMessage: '当前订阅存在付款异常，请先处理付款问题后再切换套餐。', libraryStorageBytes: 50_000_000 });
    for (const mode of ['review', 'compare'] as const) {
      expect(() => assertFusionEntitlement(result, mode, 2)).toThrow('ENTITLEMENTS_FUSION_FORBIDDEN');
    }
    f.rows.user_subscriptions = [subscription()];
    const restored = await readMembershipEntitlements(f.client, actorId);
    expect(restored).toMatchObject({ level: 'pro', state: 'active' });
    expect(() => assertFusionEntitlement(restored, 'compare', 2)).not.toThrow();
    expect(f.writes).toEqual([]);
  });
  it('denies refund reconciliation on a completed paid order and restores after resolution', async () => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription()];
    f.rows.payment_orders = [{ user_id: actorId, item_type: 'membership_plan', status: 'completed', payment_status: 'paid',
      metadata: { refundReconciliation: { reviewRequired: true } } }];
    const result = await readMembershipEntitlements(f.client, actorId);
    expect(result).toMatchObject({ level: 'free', state: 'refunded_requires_policy',
      reasonCode: 'REFUNDED_ORDER_REQUIRES_POLICY', safeMessage: '该会员订单存在退款状态，需要人工确认后再操作。' });
    for (const mode of ['review', 'compare'] as const) {
      expect(() => assertFusionEntitlement(result, mode, 2)).toThrow('ENTITLEMENTS_FUSION_FORBIDDEN');
    }
    f.rows.payment_orders[0]!.metadata = {};
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'pro', state: 'active' });
  });
  it.each([true, 'true'])('preserves cancel_at_period_end=%s until the period ends', async cancel => {
    const f = fixture();
    f.rows.user_subscriptions = [{ ...subscription(), cancel_at_period_end: cancel }];
    const result = await readMembershipEntitlements(f.client, actorId);
    expect(result).toMatchObject({ level: 'pro', state: 'cancel_at_period_end' });
    for (const mode of ['review', 'compare'] as const) {
      expect(() => assertFusionEntitlement(result, mode, 2)).not.toThrow();
    }
    f.rows.user_subscriptions[0]!.current_period_end = '2020-01-01T00:00:00Z';
    expect(await readMembershipEntitlements(f.client, actorId))
      .toMatchObject({ level: 'free', state: 'inconsistent', reasonCode: 'ENTITLEMENT_CONFLICT' });
  });
  it.each(['canceled', 'cancelled'])('maps ended %s to free and preserves a stale paid profile conflict', async status => {
    const f = fixture('free');
    f.rows.user_subscriptions = [subscription(status)];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'free', state: 'canceled' });
    f.rows.profiles![0]!.membership_level = 'pro';
    expect(await readMembershipEntitlements(f.client, actorId))
      .toMatchObject({ level: 'free', state: 'inconsistent', reasonCode: 'ENTITLEMENT_CONFLICT' });
  });
  it('preserves the existing admin override rule even with an older payment order', async () => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription('admin_override', null)];
    f.rows.payment_orders = [{ user_id: actorId, item_type: 'membership_plan', status: 'completed', payment_status: 'paid', metadata: {} }];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'pro', state: 'admin_override' });
  });
  it('allows the current paid subscription after an older manual grant or canceled subscription', async () => {
    const f = fixture();
    f.rows.user_subscriptions = [subscription('admin_override', null), subscription('canceled'), subscription()];
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'pro', state: 'active' });
  });
  it.each(['active', 'cancel_at_period_end'])('rejects a mismatched plan for %s', async state => {
    const f = fixture();
    f.rows.user_subscriptions = [{ ...subscription(), membership_plan_id: 'other-plan', cancel_at_period_end: state === 'cancel_at_period_end' }];
    expect(await readMembershipEntitlements(f.client, actorId))
      .toMatchObject({ level: 'free', state: 'inconsistent', reasonCode: 'ENTITLEMENT_CONFLICT' });
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
