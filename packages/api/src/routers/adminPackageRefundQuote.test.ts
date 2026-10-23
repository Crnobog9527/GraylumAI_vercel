/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { inferRouterContext } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
const stripeClient = vi.hoisted(() => vi.fn());
vi.mock('../services/stripe', () => ({ getStripeClient: stripeClient }));
import { logger } from '../lib/logger';
import { router } from '../trpc';
import { adminRefundProcedures } from './adminRefunds';
const app = router(adminRefundProcedures);
const actor = '33333333-3333-4333-8333-333333333333';
const input = { orderId: '11111111-1111-4111-8111-111111111111', ticketId: actor,
  feePermitted: 'not_permitted', feeEvidence: 'legal:test' };
function setup(role = 'admin', loggedIn = true) {
  const profile = { id: actor, role, status: 'active', is_deleted: 'false', membership_level: 'free', nickname: 'Fixture' };
  const scoped = { from: () => {
    const q = { select: () => q, eq: () => q, single: async () => ({ data: profile }) }; return q;
  } };
  const order = { id: input.orderId, payment_channel: 'stripe', payment_mode: 'test',
    merchant_namespace: 'acct_fixture', payment_method: 'wechat_pay', amount_total: 2900, currency: 'usd' };
  const from = vi.fn(() => {
    const q = { select: () => q, eq: () => q, single: async () => ({ data: order }),
      limit: async () => ({ data: [{ external_id: 'pi_fixture' }] }) }; return q;
  });
  const rpc = vi.fn<(name: string) => Promise<{ data: unknown; error: unknown }>>(async () =>
    ({ data: null, error: { code: 'P0001', message: 'PAY_REFUND_CREDITS_CONSUMED', details: 'PRIVATE_DIAGNOSTIC' } }));
  const write = vi.fn();
  const stripe = {
    accounts: { retrieveCurrent: vi.fn(async () => ({ id: 'acct_fixture' })) },
    balance: { retrieve: vi.fn(async () => ({ livemode: false })) },
    paymentIntents: { retrieve: vi.fn(async () => ({ id: 'pi_fixture', livemode: false, status: 'succeeded',
      amount_received: 2900, currency: 'usd', latest_charge: 'ch_fixture' })) },
    charges: { retrieve: vi.fn(async () => ({ id: 'ch_fixture', livemode: false, paid: true, captured: true,
      payment_intent: 'pi_fixture', amount: 2900, amount_captured: 2900, currency: 'usd', amount_refunded: 0,
      disputed: false, balance_transaction: { created: 1792570000 } })) },
    refunds: { list: vi.fn(async () => ({ data: [], has_more: false })), create: write },
  };
  stripeClient.mockReturnValue(stripe);
  const context = { headers: new Headers(), user: loggedIn ? { id: actor, app_metadata: {}, user_metadata: {} } : null,
    isEmailVerified: true, authProvider: 'email', supabase: scoped, supabaseAuth: scoped, supabasePublic: {},
    supabaseAdmin: { from, rpc }, hasSupabaseAdminPrivileges: true } as unknown as inferRouterContext<typeof app>;
  const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  const read = () => fetchRequestHandler({ endpoint: '/trpc', router: app, createContext: () => context,
    req: new Request('http://localhost/trpc/previewPackageRefund?input=' + encodeURIComponent(JSON.stringify(input))) });
  return { read, rpc, write, stripe, info };
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it('returns HTTP 400 with the actual consumed-credit reason through the real cash/service/RPC wrapper', async () => {
  const f = setup();
  const response = await f.read();
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(JSON.parse(body).error).toMatchObject({ message: '付款后用过积分，不符合退款条件', data: { code: 'BAD_REQUEST' } });
  expect(body).not.toContain('PRIVATE_DIAGNOSTIC');
  expect(f.info).toHaveBeenCalledWith('billing', 'package_refund_quote_refused', { code: 'PAY_REFUND_CREDITS_CONSUMED' });
  expect(f.rpc).toHaveBeenCalledTimes(1);
  expect(f.rpc.mock.calls[0][0]).toBe('pay_common_package_refund_quote');
  expect(f.write).not.toHaveBeenCalled();
});
it('keeps unknown consumption separate from a definitive used-credit refusal', async () => {
  const f = setup();
  f.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'PAY_REFUND_CONSUMPTION_OR_UNKNOWN' } });
  const response = await f.read();
  expect(response.status).toBe(400);
  const text = await response.text();
  expect(text).toContain('无法确认付款后的积分使用情况，请先核对账单');
  expect(text).not.toContain('付款后用过积分');
  expect(f.write).not.toHaveBeenCalled();
});
it.each(['database', 'provider', 'provider-reason', 'missing-sql-code'] as const)('sanitizes an unknown %s failure without misclassifying nested diagnostics', async kind => {
  const f = setup();
  if (kind === 'database') f.rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE_DIAGNOSTIC' } });
  else if (kind === 'missing-sql-code') f.rpc.mockResolvedValue({ data: null, error: { message: 'PAY_REFUND_CREDITS_CONSUMED' } });
  else if (kind === 'provider-reason') f.stripe.charges.retrieve.mockRejectedValue(new Error('PAY_REFUND_CREDITS_CONSUMED'));
  else f.stripe.charges.retrieve.mockRejectedValue(new Error('PRIVATE_DIAGNOSTIC', { cause: { message: 'PAY_REFUND_CREDITS_CONSUMED' } }));
  const response = await f.read();
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).toContain('退款证据不足或状态已变化');
  expect(text).not.toContain('PRIVATE_DIAGNOSTIC');
  expect(text).not.toContain('付款后用过积分');
  expect(JSON.stringify(f.info.mock.calls)).not.toContain('PRIVATE_DIAGNOSTIC');
  expect(f.write).not.toHaveBeenCalled();
});
it('preserves the existing successful quote response and performs no approval or cash write', async () => {
  const f = setup();
  const quote = { versionHash: 'a'.repeat(32), treatment: 'wallet_membership', credits: 3480, netMinor: 2900 };
  f.rpc.mockResolvedValue({ data: quote, error: null });
  const response = await f.read();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { data: quote } });
  expect(f.rpc).toHaveBeenCalledTimes(1);
  expect(f.write).not.toHaveBeenCalled();
});
describe('package quote retains its admin boundary', () => {
  it.each([['user', true, 403], ['admin', false, 401]] as const)('rejects %s before reading cash', async (role, loggedIn, status) => {
    const f = setup(role, loggedIn);
    expect((await f.read()).status).toBe(status);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.stripe.charges.retrieve).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
});
