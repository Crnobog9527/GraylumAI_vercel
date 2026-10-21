/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const refresh = vi.hoisted(() => vi.fn());
vi.mock('./payments/stripeTestClock', () => ({ refreshStripeTestClockUser: refresh }));
import { loadLatestMembershipFacts } from './membershipEligibility';
import { readMembershipEntitlements, readPositioningProfileEntitlement } from './membershipEntitlements';
import { actorId, fixture } from './__tests__/entitlementsFixture';

describe('test-clock refresh stays on server-owned entitlement reads', () => {
  beforeEach(() => { refresh.mockReset().mockResolvedValue(new Map()); });
  it('keeps user-scoped eligibility facts read-only even when clock refresh would reject its privileges', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { subscriptions: [], latest_order: null }, error: null });
    refresh.mockRejectedValue(new Error('service_role required'));
    await expect(loadLatestMembershipFacts({ rpc }, actorId)).resolves.toMatchObject({ error: null });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('pay_common_membership_facts', { p_user_id: actorId });
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each(['membership', 'positioning'])('refreshes %s through the supplied server client before reading effective facts', async kind => {
    const f = fixture('free');
    const rpc = vi.spyOn(f.client, 'rpc');
    refresh.mockImplementation(async (client, user) => {
      expect(client).toBe(f.client); expect(user).toBe(actorId);
      expect(rpc).not.toHaveBeenCalled();
      return new Map();
    });
    const result = await (kind === 'membership'
      ? readMembershipEntitlements(f.client, actorId) : readPositioningProfileEntitlement(f.client, actorId));
    expect(result.level).toBe('free');
    expect(refresh).toHaveBeenCalledExactlyOnceWith(f.client, actorId);
    expect(rpc).toHaveBeenCalledWith('pay_common_membership_facts', { p_user_id: actorId });
    expect(f.writes).toEqual([]);
  });
  it('fails closed before reading stale entitlements when a clock observation cannot be verified', async () => {
    const f = fixture('pro');
    const rpc = vi.spyOn(f.client, 'rpc');
    refresh.mockRejectedValue(new Error('clock is advancing'));
    await expect(readMembershipEntitlements(f.client, actorId)).rejects.toThrow('ENTITLEMENTS_UNAVAILABLE');
    expect(rpc).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
});
