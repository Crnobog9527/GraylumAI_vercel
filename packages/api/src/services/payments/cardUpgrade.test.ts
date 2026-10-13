/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), read: vi.fn(), stop: vi.fn(), sync: vi.fn() }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
vi.mock('./cardSubscriptionStop', async importActual => ({
  stripeStopState: (await importActual<typeof import('./cardSubscriptionStop')>()).stripeStopState,
  readSubscription: mocks.read, stopRenewalAfterReview: mocks.stop, syncState: mocks.sync }));
import { observeUpgradePrior, stopPriorAfterUpgrade } from './cardUpgrade';

const PRO = '00000000-0000-4000-8000-000000000001';
function fixture(row: Record<string, unknown> | null = { stripe_subscription_id: null, payment_channel: 'stripe' },
  refs: unknown[] = [{ external_id: 'sub_pro' }]) {
  const db = { rpc: vi.fn(async () => ({ error: null, data: '2026-10-14T00:00:00.000Z' })), from: vi.fn((table: string) => {
    const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain),
      limit: vi.fn(async () => ({ error: null, data: refs })), maybeSingle: vi.fn(async () => ({ error: null, data: table === 'user_subscriptions' ? row : null })) };
    return chain;
  }) };
  return { db, run: () => observeUpgradePrior(db as unknown as SupabaseClient, {} as Stripe, 'user', PRO),
    stop: (order: Record<string, unknown>) => stopPriorAfterUpgrade(db as unknown as SupabaseClient, {} as Stripe, order) };
}
const renewing = { object: 'subscription', id: 'sub_pro', status: 'active', cancel_at_period_end: false, cancel_at: null,
  metadata: { userId: 'user' }, items: { data: [{ current_period_end: 1794472954 }] } };

describe('PAY-STRIPE-MP Pro -> Gold upgrade of a card subscription', () => {
  beforeEach(() => {
    mocks.scope.mockReset().mockResolvedValue({ mode: 'test', merchant: 'fixture' });
    for (const mock of [mocks.read, mocks.stop, mocks.sync]) mock.mockReset();
  });
  it('records a fresh provider observation of a renewing Pro before the upgrade checkout', async () => {
    const f = fixture(); mocks.read.mockResolvedValue(renewing);
    await f.run();
    expect(mocks.read).toHaveBeenCalledWith({}, 'sub_pro');
    expect(f.db.rpc).toHaveBeenCalledWith('pay_stripe_mp_observe_subscription', { p_subscription: PRO, p_merchant: 'fixture' });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it('copies a stopping or past-due Pro instead, so admission refuses the upgrade with its usual answer', async () => {
    for (const patch of [{ cancel_at_period_end: true }, { status: 'past_due' }]) {
      const f = fixture(); mocks.read.mockResolvedValue({ ...renewing, ...patch });
      await f.run();
      expect(f.db.rpc).not.toHaveBeenCalled();
      expect(mocks.sync).toHaveBeenLastCalledWith(f.db, 'fixture', PRO, expect.objectContaining(patch));
    }
  });
  it('leaves non-card priors (wallet, legacy Stripe) to admission and refuses another user\'s subscription', async () => {
    for (const f of [fixture({ stripe_subscription_id: 'sub_legacy', payment_channel: 'stripe' }),
      fixture({ stripe_subscription_id: null, payment_channel: 'waffo' }), fixture(undefined, [])]) {
      await f.run();
      expect(mocks.read).not.toHaveBeenCalled(); expect(f.db.rpc).not.toHaveBeenCalled();
    }
    mocks.read.mockResolvedValue({ ...renewing, metadata: { userId: 'someone-else' } });
    await expect(fixture().run()).rejects.toThrow('PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT');
  });
  it('stops the prior card subscription at period end once the Gold upgrade is delivered, and only for upgrades', async () => {
    const f = fixture();
    await f.stop({ method_transition: 'upgrade', method_prior_subscription: PRO });
    expect(mocks.stop).toHaveBeenCalledWith(f.db, {}, 'fixture', PRO, 'sub_pro');
    await f.stop({ method_transition: null, method_prior_subscription: null });
    await f.stop({ method_transition: 'founder_renewal', method_prior_subscription: PRO });
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    await fixture({ stripe_subscription_id: null, payment_channel: 'waffo' }).stop({ method_transition: 'upgrade', method_prior_subscription: PRO });
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
});
