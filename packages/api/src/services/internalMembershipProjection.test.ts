/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { getState, loadLatestMembershipFacts, resolveMembershipEligibility } from './membershipEligibility';
import { readMembershipEntitlements, assertFusionEntitlement } from './membershipEntitlements';
import { actorId, fixture, planIds } from './__tests__/entitlementsFixture';

const paid = (level = 'gold') => ({
  id: 'internal-sub', membership_plan_id: planIds[level as keyof typeof planIds], membership_level: level,
  payment_method: 'card', mapping_state: 'internal_paid', payment_channel: 'stripe', status: 'active', billing_cycle: 'yearly',
  cancel_at_period_end: 'true', current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
});
const data = (projection: unknown) => ({
  internal_membership: projection,
  subscriptions: [{ mapping_state: 'unknown', payment_channel: 'waffo' }],
  latest_order: { status: 'refunded' },
});

describe('paid internal membership consumer projection', () => {
  it.each(['stripe', 'waffo'])('uses current paid %s order instead of stale profile/refunded unrelated order', async channel => {
    const f = fixture('free');
    vi.spyOn(f.client, 'rpc').mockResolvedValue({ data: data({ ...paid(), payment_channel: channel }), error: null } as never);
    const result = await readMembershipEntitlements(f.client, actorId);
    expect(result).toMatchObject({ level: 'gold', state: 'cancel_at_period_end', libraryStorageBytes: 2_000_000_000 });
    expect(() => assertFusionEntitlement(result, 'compare', 2)).not.toThrow();
  });
  it('uses remaining Pro authority after a refunded Gold upgrade', async () => {
    const f = fixture('gold');
    vi.spyOn(f.client, 'rpc').mockResolvedValue({ data: data(paid('pro')), error: null } as never);
    expect(await readMembershipEntitlements(f.client, actorId)).toMatchObject({ level: 'pro', libraryStorageBytes: 500_000_000 });
  });
  it.each(['internal_inactive', 'unknown'])('does not restore cached Gold for %s', async mapping_state => {
    const f = fixture('gold');
    vi.spyOn(f.client, 'rpc').mockResolvedValue({ data: data({ mapping_state, membership_level: 'free' }), error: null } as never);
    const result = await readMembershipEntitlements(f.client, actorId);
    expect(result.level).toBe('free');
    expect(() => assertFusionEntitlement(result, 'compare', 2)).toThrow('ENTITLEMENTS_FUSION_FORBIDDEN');
  });
  it('keeps access only inside the database-provided renewal grace after the paid end', () => {
    const ended = { ...paid(), payment_channel: 'waffo', cancel_at_period_end: 'false',
      current_period_end: new Date(Date.now() - 3_600_000).toISOString() };
    expect(getState({ profileLevel: 'free', latestMembershipOrder: null, latestSubscription: { ...ended,
      renewal_grace_until: new Date(Date.now() + 3_600_000).toISOString() } })).toMatchObject({ level: 'gold', state: 'active' });
    expect(getState({ profileLevel: 'gold', latestMembershipOrder: null, latestSubscription: { ...ended,
      renewal_grace_until: new Date(Date.now() - 60_000).toISOString() } })).toMatchObject({ level: 'free', state: 'free' });
    expect(getState({ profileLevel: 'gold', latestMembershipOrder: null, latestSubscription: ended }))
      .toMatchObject({ level: 'free', state: 'free' });
  });
  it.each([null, 'bad', '2000-01-01T00:00:00Z'])('fails closed for missing/invalid/expired paid end %s', end => {
    expect(getState({ profileLevel: 'gold', latestSubscription: { ...paid(), current_period_end: end },
      latestMembershipOrder: null })).toMatchObject({ level: 'free', state: 'free' });
  });
  it('preserves the existing mapped Stripe/manual selector when projection is absent', async () => {
    for (const mapping_state of ['mapped', 'none']) {
      const row = { id: 'legacy', mapping_state, payment_channel: mapping_state === 'mapped' ? 'stripe' : null, status: 'active' };
      const facts = await loadLatestMembershipFacts({ rpc: async () => ({ data: {
        subscriptions: [row], latest_order: null, internal_membership: null,
      }, error: null }) }, actorId);
      expect(facts.latestSubscription).toEqual(row);
    }
  });
});

it.each(['wechat_pay', 'alipay'])('does not require %s renewal restoration for wallet upgrades', async payment_method => {
  const supabase = { rpc: async () => ({ data: data({ ...paid('pro'), payment_method, billing_cycle: 'monthly' }), error: null }) };
  for (const targetBillingCycle of ['monthly', 'yearly'] as const) {
    const result = await resolveMembershipEligibility({ supabase, userId: actorId, profile: { membership_level: 'pro' },
      action: 'create_membership_checkout', targetPlan: { level: 'gold' }, targetBillingCycle });
    expect(result).toMatchObject({ state: 'active', reasonCode: 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION' });
    expect(result.safeMessage).not.toContain('恢复续费');
  }
});

it.each(['card', 'card_cn'])('keeps stopped %s subscriptions blocked until renewal is restored', async payment_method => {
  const supabase = { rpc: async () => ({ data: data({ ...paid('pro'), billing_cycle: 'monthly', payment_method }), error: null }) };
  for (const [targetLevel, targetBillingCycle] of [['gold', 'monthly'], ['pro', 'yearly']] as const) {
    const result = await resolveMembershipEligibility({ supabase, userId: actorId, profile: { membership_level: 'pro' },
      action: 'create_membership_checkout', targetPlan: { level: targetLevel }, targetBillingCycle });
    expect(result.reasonCode).toBe('RENEWAL_RESTORE_REQUIRED');
  }
});

it.each(['card','alipay'])('keeps a Waffo one-time %s term active for upgrades without restoring automatic renewal', async payment_method => {
  const supabase = {rpc:async()=>({data:data({...paid('pro'),payment_method,payment_channel:'waffo',
    purchase_mode:'payment',billing_cycle:'monthly'}),error:null})};
  for(const targetBillingCycle of ['monthly','yearly'] as const){
    const result = await resolveMembershipEligibility({supabase,userId:actorId,profile:{membership_level:'pro'},
      action:'create_membership_checkout',targetPlan:{level:'gold'},targetBillingCycle});
    expect(result).toMatchObject({state:'active',reasonCode:'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION'});
    expect(result.safeMessage).not.toContain('恢复续费');
  }
});
it.each(['subscription',undefined])('retains stopped legacy Waffo %s renewal state',purchase_mode=>{
  expect(getState({profileLevel:'free',latestMembershipOrder:null,latestSubscription:{...paid('pro'),
    payment_channel:'waffo',purchase_mode}})).toMatchObject({state:'cancel_at_period_end',level:'pro'});
});
