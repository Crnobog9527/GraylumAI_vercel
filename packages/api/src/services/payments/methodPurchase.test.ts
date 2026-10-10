/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ digests: vi.fn().mockResolvedValue([]) }));
vi.mock('../accountErasure/openingGrantIdentity', () => ({ loadOpeningGrantDigests: mocks.digests }));
import { methodPurchaseInputSchema, prepareMethodPurchase } from './methodPurchase';
const id = '00000000-0000-4000-8000-000000000001';
const purchase = { itemType: 'membership_plan' as const, itemId: id, billingCycle: 'monthly' as const,
  method: 'card' as const, offer: 'gold_first30' as const, routingVersion: 3, acceptedTerms: true as const };
it('requires explicit consent and rejects client prices or provider scope', () => {
  expect(methodPurchaseInputSchema.safeParse({ ...purchase, acceptedTerms: false }).success).toBe(false);
  expect(methodPurchaseInputSchema.safeParse({ ...purchase, amount: 1 }).success).toBe(false);
  expect(methodPurchaseInputSchema.safeParse({ ...purchase, merchantNamespace: 'attacker' }).success).toBe(false);
});
it('never prepares live sales; uses server scope and authenticated identity for test reservations', async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { id, user_id: id }, error: null });
  const input = { admin: { rpc } as never, userId: id, purchase, merchantNamespace: 'fixture',
    paymentMode: 'test' as const, termsVersion: 'terms-v1' };
  await expect(prepareMethodPurchase({ ...input, paymentMode: 'live' })).rejects.toThrow('LIVE_DISABLED');
  expect(rpc).not.toHaveBeenCalled();
  await prepareMethodPurchase(input);
  expect(mocks.digests).toHaveBeenCalledWith(input.admin, id);
  expect(rpc).toHaveBeenCalledWith('pay_waffo_create_purchase', expect.objectContaining({
    p_user: id, p_merchant: 'fixture', p_mode: 'test', p_terms: 'terms-v1', p_version: 3,
  }));
});
