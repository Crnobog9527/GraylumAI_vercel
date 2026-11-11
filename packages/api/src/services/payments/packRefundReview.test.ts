/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listHeldPackRefunds, settleHeldPackRefund } from './packRefundReview';

const ORDER = '00000000-0000-4000-8000-000000000001', USER = '00000000-0000-4000-8000-000000000002';
const ADMIN = '00000000-0000-4000-8000-000000000003';
function db(rows: unknown, rpc: { data?: unknown; error?: { message: string } | null } = {}) {
  const calls: Array<[string, unknown]> = [];
  const chain = { select: vi.fn((v: string) => { calls.push(['select', v]); return chain; }),
    eq: vi.fn((k: string, v: unknown) => { calls.push(['eq:' + k, v]); return chain; }),
    is: vi.fn((k: string, v: unknown) => { calls.push(['is:' + k, v]); return chain; }),
    order: vi.fn(() => chain), limit: vi.fn(async () => ({ data: rows, error: null })) };
  const client = { from: vi.fn(() => chain), rpc: vi.fn(async () => ({ data: rpc.data ?? null, error: rpc.error ?? null })) };
  return { client: client as unknown as SupabaseClient, calls, rpc: client.rpc };
}

describe('held pack refunds (deep review item 14)', () => {
  it('lists only externally refunded packs still waiting for a person', async () => {
    const f = db([{ id: ORDER, user_id: USER, payment_method: 'alipay', currency: 'usd', refund: { state: 'pack_review', packCredits: 2990,
      balanceAtRefund: 3100, refundedMinor: 2990, chargedMinor: 2990, refundedAt: '2026-11-11T00:00:00Z', lastRefundId: 're_1' } }]);
    expect(await listHeldPackRefunds(f.client)).toEqual([{ orderId: ORDER, userId: USER, method: 'alipay', currency: 'usd',
      packCredits: 2990, balanceAtRefund: 3100, refundedMinor: 2990, chargedMinor: 2990, refundedAt: '2026-11-11T00:00:00Z' }]);
    expect(f.calls).toEqual(expect.arrayContaining([['eq:item_type', 'credit_package'], ['eq:status', 'refunded'],
      ['eq:metadata->stripeExternalRefund->>state', 'pack_review'], ['is:metadata->packRefundReview', null]]));
    // An unexpected shape is an error, never an empty list that hides a held pack.
    await expect(listHeldPackRefunds(db([{ id: 'x' }]).client)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('settles through the 0285 function with the server admin identity and maps its refusals', async () => {
    const ok = db([], { data: { decision: 'clawback', duplicate: false, creditsTakenBack: 2990, creditsShortfall: 0, userId: USER } });
    expect(await settleHeldPackRefund(ok.client, ADMIN, { orderId: ORDER, decision: 'clawback' }))
      .toEqual({ decision: 'clawback', duplicate: false, creditsTakenBack: 2990, creditsShortfall: 0 });
    expect(ok.rpc).toHaveBeenCalledWith('pay_common_pack_refund_review_settle', { p_actor: ADMIN, p_order: ORDER, p_decision: 'clawback' });
    for (const [code, trpc] of [['PAY_PACK_REVIEW_ADMIN_REQUIRED', 'FORBIDDEN'], ['PAY_PACK_REVIEW_NOT_HELD', 'PRECONDITION_FAILED'],
      ['PAY_PACK_REVIEW_CONFLICT', 'CONFLICT'], ['PAY_PACK_REVIEW_SOURCE_UNKNOWN', 'PRECONDITION_FAILED']] as const) {
      await expect(settleHeldPackRefund(db([], { error: { message: code } }).client, ADMIN, { orderId: ORDER, decision: 'kept' }))
        .rejects.toMatchObject({ code: trpc });
    }
    const hidden = settleHeldPackRefund(db([], { error: { message: 'PRIVATE DETAIL' } }).client, ADMIN, { orderId: ORDER, decision: 'kept' });
    await expect(hidden).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    await expect(hidden).rejects.not.toThrow(/PRIVATE/);
  });
});
