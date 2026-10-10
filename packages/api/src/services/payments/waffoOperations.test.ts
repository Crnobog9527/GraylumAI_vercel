/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { cancelWaffoMembership, controlWaffoProduct, type WaffoTestOperations } from './waffoOperations';
const sub = '00000000-0000-4000-8000-000000000001';
function provider() {
  return { merchant: 'fixture', mode: 'test' as const,
    cancelSubscription: vi.fn(), readSubscription: vi.fn(), setProductStatus: vi.fn(), readProduct: vi.fn(),
  } satisfies WaffoTestOperations;
}
describe('test-only Waffo operations', () => {
  it('queries original cancellation after timeout and preserves paid rights until confirmed', async () => {
    const api = provider(); api.cancelSubscription.mockRejectedValue(new Error('timeout'));
    const intent = { subscriptionId: sub, providerId: 'ORD_original', merchant: 'fixture', mode: 'test' };
    const rpc = vi.fn().mockResolvedValueOnce({ data: { ...intent, dispatch: true }, error: null });
    await expect(cancelWaffoMembership({ rpc }, api, sub, sub)).rejects.toThrow('timeout');
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValueOnce({ data: { ...intent, dispatch: false }, error: null }).mockResolvedValueOnce({ error: null });
    api.readSubscription.mockResolvedValue({ orderId: 'ORD_original', status: 'canceling' });
    expect(await cancelWaffoMembership({ rpc }, api, sub, sub)).toEqual({ state: 'confirmed' });
    expect(api.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(api.readSubscription).toHaveBeenCalledWith('ORD_original');
  });
  it('uses product status only; timeout recovery never cancels existing subscribers', async () => {
    const api = provider(); api.readProduct.mockResolvedValue({ id: 'PROD_original', status: 'active' });
    api.setProductStatus.mockRejectedValue(new Error('timeout'));
    const intent = { operationId: sub, productId: 'PROD_original', merchant: 'fixture', mode: 'test', state: 'blocking', version: 1 };
    const rpc = vi.fn().mockResolvedValue({ data: intent, error: null });
    const input = { actorId: sub, priceRefId: sub, blocked: true, expectedVersion: 1 };
    await expect(controlWaffoProduct({ rpc }, api, input)).rejects.toThrow('timeout');
    api.readProduct.mockResolvedValue({ id: 'PROD_original', status: 'inactive' });
    rpc.mockResolvedValueOnce({ data: intent, error: null }).mockResolvedValueOnce({ data: { state: 'blocked' }, error: null });
    expect(await controlWaffoProduct({ rpc }, api, input)).toEqual({ state: 'blocked' });
    expect(api.setProductStatus).toHaveBeenCalledTimes(1); expect(api.cancelSubscription).not.toHaveBeenCalled();
  });
  it('rejects mismatched provider scope before external dispatch', async () => {
    const api = provider(); api.merchant = 'wrong';
    const rpc = vi.fn().mockResolvedValue({ data: { subscriptionId: sub, providerId: 'ORD_original',
      merchant: 'fixture', mode: 'test', dispatch: true }, error: null });
    await expect(cancelWaffoMembership({ rpc }, api, sub, sub)).rejects.toThrow('OPERATION_SCOPE');
    expect(api.cancelSubscription).not.toHaveBeenCalled();
  });
});
