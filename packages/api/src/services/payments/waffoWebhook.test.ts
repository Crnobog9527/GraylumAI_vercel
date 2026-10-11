/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { receiveWaffoWebhook, verifyWaffoReceipt, WAFFO_SIGNATURE_WINDOW_MS } from './waffoWebhook';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = Date.parse('2026-10-11T00:00:00Z');
const event = { eventType: 'subscription.payment_succeeded', eventId: 'PAY_1', storeId: 'STO_1', mode: 'test',
  data: { orderId: 'ORD_1', paymentId: 'PAY_1', buyerEmail: 'must-not-persist@example.invalid', chargedAmount: '49.00' } };
function fixture(value: unknown = event, timestamp = now) {
  const body = Buffer.from(JSON.stringify(value));
  const signature = createSign('RSA-SHA256').update(`${timestamp}.`).update(body).sign(privateKey, 'base64');
  return { body, signature: `t=${timestamp},v1=${signature}`, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    storeId: 'STO_1', merchantNamespace: 'fixture', now };
}
describe('Waffo authenticated durable receipt', () => {
  it('keeps resource identity only, accepts original signature on 31-minute retry', () => {
    const receipt = verifyWaffoReceipt(fixture(event, now - 31 * 60 * 1000));
    expect(receipt.refs).toEqual({ orderId: 'ORD_1', paymentId: 'PAY_1' });
    expect(receipt.requiresLookup).toBe(false);
  });
  it('uses authoritative lookup for valid old signatures and rejects future signatures', () => {
    expect(verifyWaffoReceipt(fixture(event, now - WAFFO_SIGNATURE_WINDOW_MS - 1)).requiresLookup).toBe(true);
    expect(() => verifyWaffoReceipt(fixture(event, now + 60_001))).toThrow('WAFFO_SIGNATURE_INVALID');
  });
  it('rejects altered original bytes, unsigned JSON and duplicate signature components', () => {
    const input = fixture();
    expect(() => verifyWaffoReceipt({ ...input, body: Buffer.from('invalid JSON') })).toThrow('WAFFO_SIGNATURE_INVALID');
    expect(() => verifyWaffoReceipt({ ...input, signature: null })).toThrow('WAFFO_SIGNATURE_INVALID');
    expect(() => verifyWaffoReceipt({ ...input, signature: `${input.signature},t=${now}` })).toThrow('WAFFO_SIGNATURE_INVALID');
  });
  it.each([{ ...event, mode: 'prod' }, { ...event, storeId: 'STO_other' }])('rejects wrong scope', value => {
    expect(() => verifyWaffoReceipt(fixture(value))).toThrow('WAFFO_SCOPE_MISMATCH');
  });
  it('does not acknowledge storage failure; repeated delivery uses identical database identity', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'receipt-1', error: null });
    const input = { ...fixture(), db: { rpc } as unknown as Parameters<typeof receiveWaffoWebhook>[0]['db'] };
    await receiveWaffoWebhook(input); await receiveWaffoWebhook(input);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('buyerEmail');
    rpc.mockResolvedValueOnce({ data: null, error: new Error('unavailable') });
    await expect(receiveWaffoWebhook(input)).rejects.toThrow('WAFFO_RECEIPT_UNAVAILABLE');
  });
  it.each(['subscription.past_due', 'subscription.recovered'])('accepts timestamped %s event IDs', type => {
    const id = 'ORD_5dXBtmF2HLlHfbPNm0Wcnz:2026-05-10T08:31:00.000Z';
    const receipt = verifyWaffoReceipt(fixture({ ...event, eventType: type, eventId: id }));
    expect(receipt.id).toBe(id);
  });
  it('keeps refund events distinct from payment fulfillment', async () => {
    const payment = verifyWaffoReceipt(fixture());
    const refund = verifyWaffoReceipt(fixture({ ...event, eventType: 'refund.succeeded', eventId: 'REF_1',
      data: { ...event.data, refundId: 'REF_1' } }));
    expect(refund.type).not.toBe(payment.type);
    expect(refund.refs.refundId).toBe('REF_1');
  });
});
