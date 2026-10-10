/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

export const PAYMENT_METHOD_ROUTES_KEY = 'payment_method_routes';
export const paymentMethodSchema = z.enum(['card', 'wechat_pay', 'alipay']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
const wallet = z.object({ enabled: z.boolean(), annualVerified: z.boolean() }).strict();
export const paymentMethodRoutesSchema = z.object({
  version: z.number().int().min(1).max(9999999999),
  card: z.object({ enabled: z.boolean() }).strict(),
  wechat_pay: wallet,
  alipay: wallet,
}).strict();
export type PaymentMethodRoutes = z.infer<typeof paymentMethodRoutesSchema>;

/** Fixed product decision: changes to switches never change a prior order's channel. */
export function paymentRoute(method: PaymentMethod) {
  return method === 'card' ? { channel: 'waffo' as const, mode: 'subscription' as const }
    : { channel: 'stripe' as const, mode: 'payment' as const };
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
  if (!routes || !routes[method].enabled) throw new Error('PAY_WAFFO_SALES_DISABLED');
  if (routes.version !== input.expectedVersion) throw new Error('PAY_WAFFO_ROUTE_VERSION_CONFLICT');
  if (method === 'card' && input.itemType === 'credit_package') throw new Error('PAY_WAFFO_METHOD_DENIED');
  if (method !== 'card' && input.annual && !routes[method].annualVerified) {
    throw new Error('PAY_WAFFO_ANNUAL_UNVERIFIED');
  }
  return paymentRoute(method);
}
