/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { WaffoPayment } from './waffoPayments';
import type { WaffoRefund } from './waffoTestOperationsClient';
import { decideWaffoRefund, executeWaffoRefund, previewWaffoRefund, readWaffoRefundCash,
  reconcileWaffoRefund, type RefundWaffo } from './waffoRefund';

const orderId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
const reference = `pay-common:refund:${intentId}`;
function fixture() {
  const approval = { id: intentId, orderId, ticketId: orderId, status: 'approved', netMinor: 9400, currency: 'usd',
    idempotencyKey: reference, cash: { paymentIntentId: 'PAY_fixture', chargeId: 'PAY_fixture' } };
  const order = { id: orderId, payment_channel: 'waffo', payment_mode: 'test', merchant_namespace: 'merchant',
    mode: 'payment', auto_renew: false, amount_total: 10000, currency: 'usd', provider_payment_method: 'card', refund_approval: approval };
  const payment: WaffoPayment = { id: 'PAY_fixture', orderId: 'ORD_fixture', status: 'succeeded', testMode: true,
    orderMerchantExternalId: orderId, periodNumber: null, createdAt: '2026-10-21T00:00:00Z',
    amount: { amount: '10000', currency: 'USD' }, pspAmountDetails: { amount: '100.00', currency: 'USD' },
    refundedAmount: { amount: '0', currency: 'USD' }, refundStatus: 'none', isFullyRefunded: false,
    paymentMethod: { type: 'card' }, subscriptionOrder: null, onetimeOrder: { id: 'ORD_fixture', storeId: 'STO_fixture',
      status: 'succeeded', testMode: true, orderMerchantExternalId: orderId, onetimeProduct: { id: 'PROD_fixture' } } };
  const ticket = { id: 'TKT_fixture', subjectId: payment.id, status: 'approved', refundTicketMerchantExternalId: reference };
  const refund: WaffoRefund = { id: 'REF_fixture', paymentId: payment.id, ticketId: ticket.id, status: 'succeeded', testMode: true,
    amount: { amount: '9400', currency: 'USD' }, pspAmountDetails: { amount: '94.00', currency: 'USD' },
    orderMerchantExternalId: orderId, refundTicketMerchantExternalId: reference, createdAt: '2026-10-21T01:00:00Z' };
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    if (name.endsWith('_claim')) { approval.status = 'review_required'; return { data: approval, error: null }; }
    return { data: { status: name.endsWith('_result') ? 'succeeded' : 'quoted' }, error: null };
  });
  const from = vi.fn((table: string) => {
    const query = { select: () => query, eq: () => query, single: async () => ({ data: order, error: null }),
      limit: async () => ({ data: table === 'payment_provider_refs' ? [{ external_id: payment.id }] : [], error: null }) };
    return query;
  });
  const provider = { merchant: 'merchant', mode: 'test' as 'test' | 'live', storeId: 'STO_fixture',
    readPayment: vi.fn(async () => payment), hasChargeback: vi.fn(async () => false),
    findRefunds: vi.fn(async (): Promise<WaffoRefund[]> => []), findRefundTickets: vi.fn(async () => [ticket]),
    createRefundTicket: vi.fn(async () => { calls.push('waffo.create'); return ticket; }) };
  const refunded = () => { payment.refundedAmount = refund.amount; payment.refundStatus = 'partial';
    provider.findRefunds.mockResolvedValue([refund]); };
  return { order, approval, payment, refund, ticket, calls, rpc, provider, refunded,
    db: { from, rpc } as unknown as SupabaseClient, client: provider as RefundWaffo };
}
const input = { orderId, ticketId: orderId, feePermitted: 'confirmed' as const, feeEvidence: 'documented fee policy' };

describe('Waffo one-time refund cash evidence', () => {
  it('quotes and decides from complete payment, refund and chargeback facts with no Stripe dependency', async () => {
    const f = fixture();
    expect(await readWaffoRefundCash(f.db, f.client, orderId)).toMatchObject({ paidMinor: 10000, taxMinor: 0,
      paymentIntentId: 'PAY_fixture', chargeId: 'PAY_fixture', refundCount: 0, disputed: false });
    await previewWaffoRefund(f.db, f.client, orderId, input);
    await decideWaffoRefund(f.db, f.client, orderId, { ...input, versionHash: 'hash', decision: 'approve' });
    expect(f.rpc).toHaveBeenCalledWith('pay_common_package_refund_decide', expect.objectContaining({p_version:'hash'}));
    expect(f.provider.findRefunds).toHaveBeenCalledWith({paymentId:'PAY_fixture'});
    expect(f.provider.hasChargeback).toHaveBeenCalledWith('PAY_fixture');
  });
  it.each(['merchant', 'mode', 'store', 'recurring', 'external', 'amount', 'psp', 'method', 'refunded', 'dispute', 'unknownRefund', 'lookupFailed'])(
    'fails closed on %s and sends no refund', async kind => {
      const f = fixture();
      if (kind === 'merchant') f.order.merchant_namespace = 'other';
      if (kind === 'mode') f.provider.mode = 'live';
      if (kind === 'store') f.payment.onetimeOrder!.storeId = 'STO_other';
      if (kind === 'recurring') f.order.auto_renew = true;
      if (kind === 'external') f.payment.orderMerchantExternalId = 'other';
      if (kind === 'amount') f.payment.amount.amount = '9999';
      if (kind === 'psp') f.payment.pspAmountDetails!.amount = '99.99';
      if (kind === 'method') f.payment.paymentMethod = null;
      if (kind === 'refunded') f.provider.findRefunds.mockResolvedValue([f.refund]);
      if (kind === 'dispute') f.provider.hasChargeback.mockResolvedValue(true);
      if (kind === 'unknownRefund') f.payment.refundStatus = null;
      if (kind === 'lookupFailed') f.provider.findRefunds.mockRejectedValue(new Error('incomplete'));
      await expect(executeWaffoRefund(f.db, f.client, orderId, {orderId,intentId})).rejects.toThrow();
      expect(f.provider.createRefundTicket).not.toHaveBeenCalled();
    });
  it('supports original live Alipay facts without selecting or changing live credentials', async () => {
    const f = fixture(); f.provider.mode = 'live'; f.order.payment_mode = 'live';
    f.payment.testMode = false; f.payment.onetimeOrder!.testMode = false;
    f.payment.paymentMethod = {type:'alipay'}; f.order.provider_payment_method = 'alipay';
    expect(await readWaffoRefundCash(f.db,f.client,orderId)).toMatchObject({mode:'live'});
  });
});

describe('Waffo refund dispatch and reconciliation', () => {
  it('persists the claim before sending exact net cash, then waits for actual executed refund', async () => {
    const f = fixture();
    const result = await executeWaffoRefund(f.db,f.client,orderId,{orderId,intentId});
    expect(result).toMatchObject({status:'review_required',intentId});
    expect(f.calls).toEqual(['pay_common_package_refund_claim','waffo.create']);
    expect(f.provider.createRefundTicket).toHaveBeenCalledWith({paymentId:'PAY_fixture',
      reason:`Approved Graylum refund ${intentId}`,requestedAmount:{amount:'94.00',currency:'USD'},
      refundTicketMerchantExternalId:reference});
    expect(f.rpc).not.toHaveBeenCalledWith('pay_common_package_refund_result',expect.anything());
  });
  it('does not reserve credits if the pre-dispatch original-payment read fails', async () => {
    const f = fixture(); f.provider.readPayment.mockRejectedValueOnce(new Error('provider timeout'));
    await expect(executeWaffoRefund(f.db,f.client,orderId,{orderId,intentId})).rejects.toThrow('provider timeout');
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.approval.status).toBe('approved');
    expect(f.provider.createRefundTicket).not.toHaveBeenCalled();
  });
  it('dispatches directly after the durable claim even if every subsequent read fails', async () => {
    const f = fixture();
    f.rpc.mockImplementation(async name => {
      if (name.endsWith('_claim')) {
        expect(f.provider.readPayment).toHaveBeenCalledTimes(1);
        f.approval.status = 'review_required';
        f.provider.readPayment.mockRejectedValue(new Error('read unavailable after claim'));
        vi.spyOn(f.db,'from').mockImplementation(() => { throw new Error('database read unavailable after claim'); });
        return {data:f.approval,error:null};
      }
      return {data:{status:'succeeded'},error:null};
    });
    expect(await executeWaffoRefund(f.db,f.client,orderId,{orderId,intentId})).toMatchObject({status:'review_required'});
    // The optional later reconciliation can fail, but it must never prevent the single cash dispatch.
    expect(f.provider.createRefundTicket).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('records only an independently succeeded refund, idempotently on repeated reconciliation', async () => {
    const f = fixture(); f.approval.status = 'review_required'; f.refunded();
    await reconcileWaffoRefund(f.db,f.client,orderId,orderId);
    await reconcileWaffoRefund(f.db,f.client,orderId,orderId);
    expect(f.rpc).toHaveBeenCalledWith('pay_common_package_refund_result', {p_order:orderId,p_intent:intentId,
      p_refund:{id:'REF_fixture',intentId,orderId,paymentIntentId:'PAY_fixture',chargeId:'PAY_fixture',
        currency:'usd',amount:9400,status:'succeeded',mode:'test',merchant:'merchant'}});
    expect(f.provider.createRefundTicket).not.toHaveBeenCalled();
  });
  it('never retries a timed-out ticket create even after a complete empty lookup', async () => {
    const f = fixture(); f.provider.createRefundTicket.mockRejectedValue(new Error('timeout'));
    await executeWaffoRefund(f.db,f.client,orderId,{orderId,intentId});
    f.provider.findRefundTickets.mockResolvedValue([]);
    expect(await reconcileWaffoRefund(f.db,f.client,orderId,orderId)).toMatchObject({status:'review_required'});
    expect(f.provider.createRefundTicket).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['pending','failed','ticketOnly','wrongTicket','wrongPayment','amountMismatch','duplicate','receiptLag','wrongMode'])(
    'keeps %s cash unresolved without restoring credits or resending', async kind => {
      const f = fixture(); f.approval.status = 'review_required'; f.refunded();
      if (kind === 'pending' || kind === 'failed') f.refund.status = kind;
      if (kind === 'ticketOnly') f.provider.findRefunds.mockResolvedValue([]);
      if (kind === 'wrongTicket') f.refund.ticketId = 'TKT_other';
      if (kind === 'wrongPayment') f.refund.paymentId = 'PAY_other';
      if (kind === 'amountMismatch') f.refund.pspAmountDetails.amount = '100.00';
      if (kind === 'duplicate') f.provider.findRefunds.mockResolvedValue([f.refund,{...f.refund,id:'REF_duplicate'}]);
      if (kind === 'receiptLag') f.payment.refundedAmount = {amount:'0',currency:'USD'};
      if (kind === 'wrongMode') f.refund.testMode = false;
      expect(await reconcileWaffoRefund(f.db,f.client,orderId,orderId)).toMatchObject({status:'review_required'});
      expect(f.rpc).not.toHaveBeenCalled();
      expect(f.provider.createRefundTicket).not.toHaveBeenCalled();
    });
  it('preserves uncertainty after provider success and a failed local result write', async () => {
    const f = fixture();
    f.provider.createRefundTicket.mockImplementation(async () => {f.refunded(); return f.ticket;});
    f.rpc.mockImplementation(async name => {
      if (name.endsWith('_claim')) return {data:f.approval,error:null};
      return {data:null as never,error:{message:'database unavailable'} as never};
    });
    expect(await executeWaffoRefund(f.db,f.client,orderId,{orderId,intentId})).toMatchObject({status:'review_required'});
    expect(f.provider.createRefundTicket).toHaveBeenCalledTimes(1);
  });
});
