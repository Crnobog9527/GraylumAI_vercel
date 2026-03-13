/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { ensureWorkspaceServerEnv } from '../lib/serverEnv';

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
  const headerAppUrl = deriveAppUrlFromHeaders(headers);
  if (headerAppUrl) {
    return headerAppUrl;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (!appUrl) {
    throw new Error('NEXT_PUBLIC_APP_URL is not configured');
  }

  return normalizeAppUrl(appUrl);
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
