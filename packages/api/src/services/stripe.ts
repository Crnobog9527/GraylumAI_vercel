/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { isIP } from 'node:net';
import { TRPCError } from '@trpc/server';
import { ensureWorkspaceServerEnv } from '../lib/serverEnv';
import { checkRateLimit } from './redisRateLimiter';

// Reuse the existing distributed windows with checkout-specific key namespaces:
// 5 per user / 5 minutes, 20 per IP / minute. No in-memory fallback for payments.
export async function assertCheckoutRateLimit(userId: string, headers: Headers) {
  return assertPaymentRateLimit(userId, headers, 'checkout');
}

export async function assertSubscriptionChangeRateLimit(userId: string, headers: Headers) {
  return assertPaymentRateLimit(userId, headers, 'subscription-change');
}

async function assertPaymentRateLimit(userId: string, headers: Headers, namespace: string) {
  const rawIp = process.env.VERCEL === '1'
    ? headers.get('x-vercel-forwarded-for')
    : process.env.NODE_ENV !== 'production'
      ? headers.get('x-forwarded-for')
      : null;
  const ip = rawIp?.trim();
  if (!ip || !isIP(ip)) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '支付请求来源暂无法验证，请稍后重试' });
  }
  const normalizedIp = isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
  for (const [key, type] of [
    [`${namespace}:user:${userId}`, 'auth'],
    [`${namespace}:ip:${normalizedIp}`, 'anonymous'],
  ] as const) {
    const result = await checkRateLimit(key, type).catch(() => {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '支付限流服务暂不可用，请稍后重试' });
    });
    // The shared service reports limit=0 when it falls back to fail-open.
    if (!Number.isFinite(result.limit) || result.limit <= 0 || result.reason === 'unavailable') {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '支付限流服务暂不可用，请稍后重试' });
    }
    if (!result.success) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '支付请求过于频繁，请稍后重试' });
    }
  }
}

export function getStripePortalReturnUrl(requestedUrl?: string): string {
  // Only the server-configured origin and this exact Profile destination are allowed.
  const appUrl = new URL(getStripeAppUrl());
  if (appUrl.username || appUrl.password || !['http:', 'https:'].includes(appUrl.protocol)) {
    throw new Error('Invalid portal application URL');
  }
  const allowedUrl = new URL('/profile?tab=subscription', appUrl.origin).href;
  if (requestedUrl !== undefined && requestedUrl !== allowedUrl) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '无效的返回地址' });
  }
  return allowedUrl;
}

export type StripeCheckoutItemType = 'credit_package' | 'membership_plan';
export type StripeBillingCycle = 'one_time' | 'monthly' | 'yearly';
export type StripeInlinePrice = {
  currency: 'usd';
  unitAmount: number;
  productName: string;
};

const STRIPE_CHECKOUT_REQUIRED_ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NEXT_PUBLIC_APP_URL',
] as const;

let stripeClient: Stripe | null = null;

export function isStripeCheckoutConfigured(): boolean {
  ensureWorkspaceServerEnv();
  return getStripeCheckoutConfigurationIssues().length === 0;
}

export function getStripeCheckoutConfigurationIssues(): string[] {
  ensureWorkspaceServerEnv();
  return STRIPE_CHECKOUT_REQUIRED_ENV_KEYS.filter((key) => !process.env[key]);
}

export function assertStripeCheckoutConfigured(): void {
  ensureWorkspaceServerEnv();
  const missingKeys = getStripeCheckoutConfigurationIssues();

  if (missingKeys.length === 0) {
    return;
  }

  throw new Error(`Stripe checkout is not fully configured: missing ${missingKeys.join(', ')}`);
}

export function getStripeClient(): Stripe {
  ensureWorkspaceServerEnv();
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  stripeClient ??= new Stripe(secretKey);
  return stripeClient;
}

export function getStripeWebhookSecret(): string {
  ensureWorkspaceServerEnv();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }

  return webhookSecret;
}

function normalizeAppUrl(appUrl: string): string {
  return appUrl.replace(/\/$/, '');
}

function assertValidAppUrl(appUrl: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(appUrl);
  } catch {
    throw new Error('NEXT_PUBLIC_APP_URL is not a valid absolute URL');
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost' && parsedUrl.hostname !== '127.0.0.1') {
    throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS outside local development');
  }

  return normalizeAppUrl(parsedUrl.toString());
}

function isTrustedHeaderAppUrl(headerAppUrl: string, configuredAppUrl: string | null): boolean {
  if (configuredAppUrl && headerAppUrl === configuredAppUrl) {
    return true;
  }

  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  try {
    const parsedUrl = new URL(headerAppUrl);
    return parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function deriveAppUrlFromHeaders(headers?: Headers): string | null {
  if (!headers) {
    return null;
  }

  const origin = headers.get('origin');
  if (origin && origin !== 'null') {
    return normalizeAppUrl(origin);
  }

  const forwardedHost = headers.get('x-forwarded-host');
  const host = forwardedHost || headers.get('host');
  if (!host) {
    return null;
  }

  const forwardedProto = headers.get('x-forwarded-proto');
  const protocol = forwardedProto || (host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https');
  return normalizeAppUrl(`${protocol}://${host}`);
}

export function getStripeAppUrl(headers?: Headers): string {
  ensureWorkspaceServerEnv();
  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL
    ? assertValidAppUrl(normalizeAppUrl(process.env.NEXT_PUBLIC_APP_URL))
    : null;
  const headerAppUrl = deriveAppUrlFromHeaders(headers);
  if (headerAppUrl && isTrustedHeaderAppUrl(headerAppUrl, configuredAppUrl)) {
    return headerAppUrl;
  }

  const appUrl = configuredAppUrl;

  if (!appUrl) {
    throw new Error('NEXT_PUBLIC_APP_URL is not configured');
  }

  return appUrl;
}

export function createServiceRoleSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase service role credentials are not configured');
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

async function resolveActiveStripeCustomerId(
  stripe: Stripe,
  candidateCustomerId: string | null,
): Promise<string | null> {
  if (!candidateCustomerId) {
    return null;
  }

  try {
    const customer = await stripe.customers.retrieve(candidateCustomerId);
    if (customer.deleted) {
      return null;
    }

    return customer.id;
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === 'resource_missing'
    ) {
      return null;
    }

    throw error;
  }
}

export async function getOrCreateStripeCustomerId(params: {
  supabase: any;
  userId: string;
  email?: string | null;
  nickname?: string | null;
}) {
  const { supabase, userId, email, nickname } = params;

  const [subscriptionResult, orderResult] = await Promise.all([
    supabase
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .not('stripe_customer_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('payment_orders')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .not('stripe_customer_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const existingCustomerId =
    subscriptionResult.data?.stripe_customer_id ||
    orderResult.data?.stripe_customer_id ||
    null;

  const stripe = getStripeClient();
  const activeCustomerId = await resolveActiveStripeCustomerId(stripe, existingCustomerId);

  if (activeCustomerId) {
    return activeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: email || undefined,
    name: nickname || undefined,
    metadata: {
      userId,
    },
  });

  return customer.id;
}

export function buildStripeMetadata(input: {
  itemType: StripeCheckoutItemType;
  itemId: string;
  userId: string;
  priceId: string;
  billingCycle: StripeBillingCycle;
}) {
  return {
    itemType: input.itemType,
    itemId: input.itemId,
    userId: input.userId,
    priceId: input.priceId,
    billingCycle: input.billingCycle,
  };
}

export function normalizePackageDiscount(packageDiscount: number | null | undefined): number {
  if (typeof packageDiscount !== 'number' || Number.isNaN(packageDiscount)) {
    return 100;
  }

  return Math.min(100, Math.max(0, Math.round(packageDiscount)));
}

export function calculateDiscountedAmountCents(params: {
  amountCents: number;
  packageDiscount: number | null | undefined;
}) {
  const normalizedDiscount = normalizePackageDiscount(params.packageDiscount);
  const baseAmountCents = Math.max(0, Math.round(params.amountCents));

  return {
    baseAmountCents,
    normalizedDiscount,
    discountedAmountCents: Math.max(0, Math.round((baseAmountCents * normalizedDiscount) / 100)),
  };
}
