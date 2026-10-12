/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

export const PAYMENT_METHOD_ROUTES_KEY = 'payment_method_routes';
/** `card`: international card through Stripe Managed Payments; `card_cn`: mainland China card
 * subscription through plain Stripe (Owner 2026-10-12). */
export const paymentMethodSchema = z.enum(['card', 'card_cn', 'wechat_pay', 'alipay']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
const wallet = z.object({ enabled: z.boolean(), annualVerified: z.boolean() }).strict();
export const paymentMethodRoutesSchema = z.object({
  version: z.number().int().min(1).max(9999999999),
  card: z.object({ enabled: z.boolean() }).strict(),
  // Optional so settings saved before card_cn existed stay valid; absent means closed.
  card_cn: z.object({ enabled: z.boolean() }).strict().optional(),
  wechat_pay: wallet,
  alipay: wallet,
}).strict();
export type PaymentMethodRoutes = z.infer<typeof paymentMethodRoutesSchema>;

const cardMethods: ReadonlySet<PaymentMethod> = new Set(['card', 'card_cn']);
export const isCardMethod = (method: PaymentMethod) => cardMethods.has(method);

/** Fixed product decision (Owner 2026-10-12): every new purchase goes to Stripe. Changes to switches
 * never change a prior order's channel; existing Waffo orders keep Waffo for renewal and refunds. */
export function paymentRoute(method: PaymentMethod, itemType: 'membership_plan' | 'credit_package' = 'membership_plan') {
  const recurring = isCardMethod(method) && itemType === 'membership_plan';
  return { channel: 'stripe' as const, mode: recurring ? 'subscription' as const : 'payment' as const,
    managedPayments: method === 'card' };
}

export async function readPaymentMethodRoutes(db: Pick<SupabaseClient, 'from'>) {
  const { data, error } = await db.from('system_settings').select('value')
    .eq('key', PAYMENT_METHOD_ROUTES_KEY).maybeSingle();
  if (error) throw new Error('PAY_WAFFO_ROUTES_UNAVAILABLE');
  if (!data) return null;
  const parsed = paymentMethodRoutesSchema.safeParse(data.value);
  if (!parsed.success) throw new Error('PAY_WAFFO_ROUTES_INVALID');
  return parsed.data;
}

export function assertPaymentMethodRoute(input: {
  routes: PaymentMethodRoutes | null; expectedVersion: number;
  method: PaymentMethod; annual: boolean; itemType: 'membership_plan' | 'credit_package';
  paymentMode: 'test' | 'live';
}) {
  if (input.paymentMode !== 'test') throw new Error('PAY_WAFFO_LIVE_DISABLED');
  const { routes, method } = input;
  if (!routes || routes[method]?.enabled !== true) throw new Error('PAY_WAFFO_SALES_DISABLED');
  if (routes.version !== input.expectedVersion) throw new Error('PAY_WAFFO_ROUTE_VERSION_CONFLICT');
  // Mainland users buy credit packs by wallet; international card packs are one-time MP sales.
  if (method === 'card_cn' && input.itemType === 'credit_package') throw new Error('PAY_WAFFO_METHOD_DENIED');
  if ((method === 'wechat_pay' || method === 'alipay') && input.annual && !routes[method].annualVerified) {
    throw new Error('PAY_WAFFO_ANNUAL_UNVERIFIED');
  }
  return paymentRoute(method, input.itemType);
}
