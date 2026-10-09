/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { TRPCError } from '@trpc/server';
const stripeClient = vi.hoisted(() => vi.fn());
vi.mock('../services/stripe', () => ({ getStripeClient: stripeClient }));
import { router } from '../trpc';
import { adminRefundProcedures } from './adminRefunds';

const testRouter = router(adminRefundProcedures);
const orderId = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const rejection = { orderId, ticketId: '33333333-3333-4333-8333-333333333333', reason: 'ineligible' as const };
function setup(row: Record<string, unknown> | null = { id: orderId, refund_approval: null }, role = 'admin') {
  const read = vi.fn(async () => ({ data: row, error: null as unknown }));
  const write = vi.fn(() => { throw new Error('UNEXPECTED_WRITE'); });
  const query = { select: vi.fn(() => query), eq: vi.fn(() => query), single: read, maybeSingle: read,
    insert: write, update: write, delete: write, upsert: write };
  const rpc = vi.fn(async () => ({ data: null as unknown, error: { message: 'PAY_MONTHLY_REJECTION_INVALID' } as unknown }));
  const from = vi.fn(() => query);
  const profile = { id: actor, role, status: 'active', is_deleted: 'false', membership_level: 'free', nickname: 'Fixture' };
  const scoped = { from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: profile }) }) };
  const caller = testRouter.createCaller({ headers: new Headers(),
    user: { id: actor, app_metadata: {}, user_metadata: {} }, isEmailVerified: true, authProvider: 'email',
    supabase: scoped, supabaseAuth: scoped, supabasePublic: {}, supabaseAdmin: { from, rpc }, hasSupabaseAdminPrivileges: true,
  } as unknown as Parameters<typeof testRouter.createCaller>[0]);
  return { caller, read, write, rpc, from };
}
afterEach(() => vi.clearAllMocks());
async function expectError(action: Promise<unknown>, message: string, status: number) {
  const error = await action.catch(error => error);
  expect(error).toBeInstanceOf(TRPCError);
  expect(error.message).toBe(message);
  expect(getHTTPStatusCodeFromError(error)).toBe(status);
  expect(error.cause).toBeUndefined();
}
describe('monthly refund status and rejection through real admin route/service', () => {
  it('returns null for an existing order without a refund record, including repeat/concurrent reads', async () => {
    const f = setup();
    expect(await f.caller.getMonthlyRefundStatus({ orderId })).toBeNull();
    expect(await Promise.all([f.caller.getMonthlyRefundStatus({ orderId }), f.caller.getMonthlyRefundStatus({ orderId })]))
      .toEqual([null, null]);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(stripeClient).not.toHaveBeenCalled();
  });
  it('rejects an unknown order before any RPC or write, including repeated/concurrent submissions', async () => {
    const f = setup(null);
    await expectError(f.caller.rejectMonthlyRefund(rejection), 'PAY_REFUND_ORDER_UNKNOWN', 400);
    await Promise.all([1, 2].map(() =>
      expectError(f.caller.rejectMonthlyRefund(rejection), 'PAY_REFUND_ORDER_UNKNOWN', 400)));
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
    expect(stripeClient).not.toHaveBeenCalled();
  });
});
