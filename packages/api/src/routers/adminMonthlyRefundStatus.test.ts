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
  if (!(error instanceof TRPCError)) throw new Error('Expected a tRPC error');
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
  it('distinguishes an unknown order from an existing order with no record', async () => {
    const f = setup(null);
    await expectError(f.caller.getMonthlyRefundStatus({ orderId }), 'PAY_REFUND_ORDER_UNKNOWN', 400);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['approved', 'rejected', 'succeeded'])('preserves an existing %s record', async status => {
    const record = { kind: 'monthly_first_purchase', id: 'intent', status };
    const f = setup({ id: orderId, refund_approval: record });
    expect(await f.caller.getMonthlyRefundStatus({ orderId })).toEqual(record);
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(['read-error', 'thrown-error', 'wrong-kind', 'missing-field'])
    ('does not turn %s into an empty status', async scenario => {
      const f = setup({ id: orderId, refund_approval: { kind: 'package' } });
      if (scenario === 'read-error') f.read.mockResolvedValue({ data: null, error: { message: 'PRIVATE_DIAGNOSTIC' } });
      if (scenario === 'thrown-error') f.read.mockRejectedValue(new Error('PRIVATE_DIAGNOSTIC'));
      if (scenario === 'missing-field') f.read.mockResolvedValue({ data: { id: orderId }, error: null });
      await expectError(f.caller.getMonthlyRefundStatus({ orderId }), 'PAY_REFUND_STATUS_UNAVAILABLE', 500);
      expect(f.rpc).not.toHaveBeenCalled();
    });
  it('does not call rejection RPC when the existence read fails', async () => {
    const f = setup();
    f.read.mockResolvedValue({ data: null, error: { message: 'PRIVATE_DIAGNOSTIC' } });
    await expectError(f.caller.rejectMonthlyRefund(rejection), 'PAY_REFUND_REJECT_UNAVAILABLE', 500);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(['PAY_MONTHLY_REJECTION_INVALID', 'PAY_REFUND_ALREADY_DISPATCHED', 'PAY_REFUND_ADMIN_REQUIRED'])
    ('preserves the exact transaction refusal %s', async message => {
      const f = setup();
      f.rpc.mockResolvedValue({ data: null, error: { message, details: 'PRIVATE_DIAGNOSTIC' } });
      await expectError(f.caller.rejectMonthlyRefund(rejection), message, 400);
      expect(f.write).not.toHaveBeenCalled();
    });
  it.each(['PRIVATE_DIAGNOSTIC', 'PAY_MONTHLY_REJECTION_INVALID extra'])
    ('sanitizes unknown transaction failure %s', async message => {
      const f = setup();
      f.rpc.mockResolvedValue({ data: null, error: { message } });
      await expectError(f.caller.rejectMonthlyRefund(rejection), 'PAY_REFUND_REJECT_UNAVAILABLE', 500);
    });
  it('preserves the successful rejection transaction and its inputs', async () => {
    const f = setup();
    const record = { kind: 'monthly_first_purchase', status: 'rejected' };
    f.rpc.mockResolvedValue({ data: record, error: null });
    expect(await f.caller.rejectMonthlyRefund(rejection)).toEqual(record);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('pay_common_monthly_refund_reject', {
      p_actor: actor, p_order: orderId, p_ticket: rejection.ticketId, p_reason: rejection.reason,
    });
    expect(stripeClient).not.toHaveBeenCalled();
  });
  it('denies non-admins before reading refund data or invoking RPC', async () => {
    const f = setup(null, 'user');
    await expect(f.caller.getMonthlyRefundStatus({ orderId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller.rejectMonthlyRefund(rejection)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.from).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });

});
