/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCardPortalSubscription } from './stripePortal';

const scope = { merchant: 'fixture', mode: 'test' as const };
type Sub = { id: string; cancel_at_period_end: string; current_period_end: string };
function db(subs: Sub[], replaced: string[] = []) {
  return { from: vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = { select: () => chain, eq: (k: string, v: unknown) => { filters[k] = v; return chain; }, is: () => chain,
      in: () => chain, not: () => chain,
      limit: async () => {
        if (table === 'user_subscriptions') return { data: subs, error: null };
        if (table === 'payment_provider_refs') return { data: [{ external_id: `sub_${String(filters.subscription_id)}` }], error: null };
        if (filters.method_transition === 'upgrade') return { data: replaced.map(id => ({ method_prior_subscription: id })), error: null };
        return { data: [{ id: `order_${String(filters.subscription_id)}` }], error: null };
      } };
    return chain;
  }) } as unknown as SupabaseClient;
}
const sub = (id: string, stopped: boolean, end: string): Sub => ({ id, cancel_at_period_end: String(stopped), current_period_end: end });

describe('PAY-STRIPE-MP card subscription managed in the portal', () => {
  it('manages the renewing subscription when one renews', async () => {
    await expect(loadCardPortalSubscription(db([sub('pro', true, '2027-01-01'), sub('gold', false, '2026-11-01')]), 'u', scope))
      .resolves.toMatchObject({ localId: 'gold', stripeSubscriptionId: 'sub_gold' });
  });
  it('never picks the subscription an upgrade replaced when every one is stopped, even if it ends later', async () => {
    // Annual Pro upgraded to monthly Gold, then Gold stopped too: the Gold renewal can be restored, the Pro cannot.
    await expect(loadCardPortalSubscription(db([sub('pro', true, '2027-01-01'), sub('gold', true, '2026-11-01')], ['pro']), 'u', scope))
      .resolves.toMatchObject({ localId: 'gold' });
    await expect(loadCardPortalSubscription(db([sub('a', true, '2026-11-01'), sub('b', true, '2027-01-01')]), 'u', scope))
      .resolves.toMatchObject({ localId: 'b' });
    // The Gold already canceled (no longer open): the replaced Pro alone is still not offered for restoring.
    await expect(loadCardPortalSubscription(db([sub('pro', true, '2027-01-01')], ['pro']), 'u', scope)).resolves.toBeNull();
    await expect(loadCardPortalSubscription(db([sub('pro', true, '2027-01-01')]), 'u', scope)).resolves.toMatchObject({ localId: 'pro' });
  });
  it('refuses two renewing card subscriptions and returns null without one', async () => {
    await expect(loadCardPortalSubscription(db([sub('a', false, '2026-11-01'), sub('b', false, '2027-01-01')]), 'u', scope))
      .rejects.toThrow('PAY_COMMON_MEMBERSHIP_FACTS_UNKNOWN');
    await expect(loadCardPortalSubscription(db([]), 'u', scope)).resolves.toBeNull();
  });
});
