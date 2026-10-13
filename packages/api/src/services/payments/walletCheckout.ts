/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createStripeMethodCheckout } from './stripeMethodCheckout';

export async function createWalletCheckout(input: Parameters<typeof createStripeMethodCheckout>[0]) {
  if (input.purchase.method === 'card' || input.purchase.method === 'card_cn') throw new Error('PAY_WAFFO_METHOD_DENIED');
  return createStripeMethodCheckout(input);
}
