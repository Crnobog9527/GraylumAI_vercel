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
it('keeps the admission refusal code: known business refusals are typed, everything else stays an outage', async () => {
  const { MethodPurchaseRejected } = await import('./methodPurchaseError');
  const run = (message: string) => prepareMethodPurchase({ admin: { rpc: vi.fn().mockResolvedValue({ data: null,
    error: { message } }) } as never, userId: id, purchase, merchantNamespace: 'fixture', paymentMode: 'test', termsVersion: 'terms-v1' });
  const refused = await run('PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED').catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(MethodPurchaseRejected);
  expect(refused).toMatchObject({ message: 'PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED' });
  const fault = await run('PAY_WAFFO_CATALOG_NOT_READY').catch((error: unknown) => error);
  expect(fault).not.toBeInstanceOf(MethodPurchaseRejected);
  expect(fault).toMatchObject({ message: 'PAY_WAFFO_CATALOG_NOT_READY' });
  await expect(run('connection reset')).rejects.toThrow('PAY_WAFFO_PURCHASE_DENIED');
});
