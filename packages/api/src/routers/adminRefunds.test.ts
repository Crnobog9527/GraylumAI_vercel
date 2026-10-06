/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
const actions = vi.hoisted(() => ({
  readPackageRefundStatus: vi.fn(async () => ({ status: 'approved' })),
  rejectPackageRefund: vi.fn(async () => ({ status: 'rejected' })),
  previewPackageRefund: vi.fn(async () => ({ status: 'eligible' })),
  decidePackageRefund: vi.fn(async () => ({ status: 'approved' })),
  executePackageRefund: vi.fn(async () => ({ status: 'succeeded' })),
  reconcilePackageRefund: vi.fn(async () => ({ status: 'succeeded' })),
}));
vi.mock('../services/payments/packageRefund', () => actions);
vi.mock('../services/stripe', () => ({ getStripeClient: () => ({}) }));
import { router } from '../trpc';
import { adminRefundProcedures } from './adminRefunds';
const testRouter = router(adminRefundProcedures);
const actor = '33333333-3333-4333-8333-333333333333';
const request = { orderId: actor, ticketId: actor, feePermitted: 'confirmed' as const, feeEvidence: 'legal-reference' };
function caller(role: string, loggedIn = true) {
  const profile = { id: actor, role, status: 'active', is_deleted: 'false', membership_level: 'free', nickname: 'Fixture' };
  const scoped = { from: () => ({
    select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }),
  }) };
  return testRouter.createCaller({
    headers: new Headers(), user: loggedIn ? { id: actor, app_metadata: {}, user_metadata: {} } : null,
    isEmailVerified: true, authProvider: 'email', supabase: scoped, supabaseAuth: scoped,
    supabasePublic: {}, supabaseAdmin: {}, hasSupabaseAdminPrivileges: true,
  } as unknown as Parameters<typeof testRouter.createCaller>[0]);
}
beforeEach(() => vi.clearAllMocks());
describe('refund admin permission boundary', () => {
  it('allows the existing admin route and uses server profile identity', async () => {
    await caller('admin').previewPackageRefund(request);
    expect(actions.previewPackageRefund).toHaveBeenCalledWith({}, {}, actor, request);
  });
  it.each(['user', 'anonymous'])('rejects %s before any refund service', async role => {
    const c = caller(role, role !== 'anonymous');
    await expect(c.previewPackageRefund(request)).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
    await expect(c.decidePackageRefund({ ...request, decision: 'approve', versionHash: 'a'.repeat(32) })).rejects.toThrow();
    await expect(c.executePackageRefund({ orderId: actor, intentId: actor })).rejects.toThrow();
    await expect(c.getPackageRefundStatus({ orderId: actor })).rejects.toThrow();
    await expect(c.rejectPackageRefund({ orderId: actor, ticketId: actor, reason: 'ineligible' })).rejects.toThrow();
    await expect(c.reconcilePackageRefund({ orderId: actor })).rejects.toThrow();
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });
  it('rejects client cash and approval evidence injection', async () => {
    await expect(caller('admin').previewPackageRefund({ ...request, netMinor: 1 } as typeof request)).rejects.toThrow();
    expect(actions.previewPackageRefund).not.toHaveBeenCalled();
  });
});
