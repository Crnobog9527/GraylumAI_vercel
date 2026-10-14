/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Card checkout through `payments.methodCheckout` (PAY-STRIPE-MP step 5, #847 MIGRATION-PLAN §2.1).
 * Pure helpers: which card methods to offer, the tax copy next to a price, the return-URL check and
 * the text for each server refusal. The server decides prices, eligibility and offers; nothing here
 * grants a purchase. Wallets stay closed in code and are never offered.
 */
export type CardMethod = 'card' | 'card_cn';
export type MethodOffer = 'standard' | 'gold_first30' | 'founder' | 'founder_renewal';

export type MethodPurchase = {
  itemType: 'membership_plan' | 'credit_package';
  itemId: string;
  billingCycle: 'monthly' | 'yearly' | 'one_time';
  offer: MethodOffer;
  transition?: 'upgrade' | 'founder_renewal';
  priorSubscriptionId?: string;
};

/** The fields of `payments.methodMembership` the purchase entry reads. */
export type MethodMembershipEntry = {
  checkoutReady: boolean;
  termsVersion: string | null;
  goldFirstMonthEligible: boolean;
  routes: { version: number; card: { enabled: boolean }; card_cn?: { enabled: boolean } } | null;
};

/** Gold monthly first month (Owner 2026-10-12: natural month, one-time coupon). Shown only when the server says eligible. */
export const GOLD_FIRST_MONTH_USD = 49;

export const METHOD_COPY: Record<CardMethod, { label: string; note: string | null; tax: string }> = {
  card: { label: '国际银行卡 / Apple Pay / Google Pay', note: null, tax: '税另计，结账时按所在地计算' },
  card_cn: { label: '中国大陆银行卡', note: '仅限中国大陆用户', tax: '不另收税' },
};

export const TERMS_LINKS = { terms: '/terms', refund: '/faq' } as const;

export const CHECKOUT_COPY = {
  unavailable: '暂时无法创建付款，请稍后查看原订单状态',
  recovery: '原来的付款页面已经不能用了。为避免重复付款，请不要重新下单，稍后到个人中心的账单记录查看这笔订单的状态。',
  badUrl: '付款页面地址异常，已停止跳转。为避免重复付款，请不要重新下单，稍后到个人中心的账单记录查看这笔订单的状态。',
  rateLimited: '下单太频繁了，请稍等一分钟再试。',
  closed: '银行卡付款暂未开放，请稍后再来。',
  termsRequired: '请先勾选同意《服务条款》和《退款政策》。',
  mainlandHint: '如果你在中国大陆，国际银行卡付款页会提示不支持；请回来改选“中国大陆银行卡”。',
} as const;

/** The card entry shows only when the server says card checkout is open and a terms version is published. */
export function checkoutEntryOpen(entry: MethodMembershipEntry | null | undefined): entry is MethodMembershipEntry & {
  termsVersion: string; routes: NonNullable<MethodMembershipEntry['routes']>;
} {
  return Boolean(entry && entry.checkoutReady === true && typeof entry.termsVersion === 'string'
    && entry.termsVersion.length > 0 && entry.routes);
}

/** Card methods the routes allow for this item; the mainland card only sells membership subscriptions. */
export function cardMethods(entry: MethodMembershipEntry | null | undefined, itemType: MethodPurchase['itemType']): CardMethod[] {
  if (!checkoutEntryOpen(entry)) return [];
  const methods: CardMethod[] = [];
  if (entry.routes.card.enabled === true) methods.push('card');
  if (entry.routes.card_cn?.enabled === true && itemType === 'membership_plan') methods.push('card_cn');
  return methods;
}

/** Only an https Stripe-hosted checkout page may receive the user; anything else is not followed. */
export function isStripeCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.port
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

export type CheckoutRefusal = { message: string; goldFirstIneligible: boolean };

const BUSINESS_CODES = new Set(['PRECONDITION_FAILED', 'CONFLICT', 'FORBIDDEN', 'BAD_REQUEST']);

/** Business refusals show the server's own message; outages and anything unexpected get one generic line. */
export function describeCheckoutError(error: unknown): CheckoutRefusal {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  const raw = error && typeof error === 'object' && 'message' in error ? error.message : '';
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (code === 'TOO_MANY_REQUESTS') {
    return { message: /频繁/.test(message) && message.length <= 80 ? message : CHECKOUT_COPY.rateLimited, goldFirstIneligible: false };
  }
  // Input validation failures arrive as a JSON issue list; they are not a business answer to show.
  if (typeof code === 'string' && BUSINESS_CODES.has(code) && message && !message.startsWith('[') && message.length <= 200) {
    return { message, goldFirstIneligible: code === 'PRECONDITION_FAILED' && message.includes('首月') };
  }
  return { message: CHECKOUT_COPY.unavailable, goldFirstIneligible: false };
}
