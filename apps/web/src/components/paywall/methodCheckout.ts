/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Checkout through `payments.methodCheckout` (PAY-STRIPE-MP step 5, #847 MIGRATION-PLAN §2.1).
 * Pure helpers: which server-enabled methods to offer, the tax copy next to a price, the return-URL
 * check and the text for each server refusal. The server decides prices, eligibility and offers.
 */
export type CheckoutMethod = 'card' | 'card_cn' | 'wechat_pay' | 'alipay';
export type MethodOffer = 'standard' | 'gold_first30' | 'founder' | 'founder_renewal';

export type MethodPurchase = {
  itemType: 'membership_plan' | 'credit_package';
  itemId: string;
  billingCycle: 'monthly' | 'yearly' | 'one_time';
  offer: MethodOffer;
  transition?: 'upgrade' | 'founder_renewal' | 'wallet_renewal';
  priorSubscriptionId?: string;
};

/** The fields of `payments.methodMembership` the purchase entry reads. */
export type MethodMembershipEntry = {
  /** Payment mode the server sells in; only 'test' (Stripe test mode, no real money) may use the interim refund link. */
  mode?: string;
  checkoutReady: boolean;
  termsVersion: string | null;
  goldFirstMonthEligible: boolean;
  founder?: { total: number; available: number };
  routes: { version: number; card: { enabled: boolean }; card_cn?: { enabled: boolean };
    wechat_pay?: { enabled: boolean; annualVerified: boolean }; alipay?: { enabled: boolean; annualVerified: boolean } } | null;
  /** Methods the server has allowed for this deployment after applying its environment gate. */
  checkoutMethods: CheckoutMethod[];
};

/** Gold monthly first month (Owner 2026-10-12: natural month, one-time coupon). Shown only when the server says eligible. */
export const GOLD_FIRST_MONTH_USD = 49;
/** Founder Gold yearly: first 50 Gold yearly buyers, renews at $496 while unbroken (MASTER_PLAN §2.1 item 51 record V; 2026-10-10). */
export const GOLD_FOUNDER_YEAR_USD = 496;

/** Real seats left from the server; never a countdown or invented scarcity. */
export function founderSeatsLeft(entry: MethodMembershipEntry | null | undefined) {
  const left = entry?.founder?.available;
  return typeof left === 'number' && Number.isInteger(left) && left > 0 ? left : 0;
}

export const METHOD_COPY: Record<CheckoutMethod, { label: string; note: string | null; tax: string }> = {
  card: { label: '国际银行卡 / Apple Pay / Google Pay', note: null, tax: '税另计，结账时按所在地计算' },
  card_cn: { label: '中国大陆银行卡', note: '仅限中国大陆用户', tax: '不另收税' },
  wechat_pay: { label: '微信支付', note: null, tax: '不另收税' },
  alipay: { label: '支付宝', note: null, tax: '不另收税' },
};

/**
 * MASTER_PLAN §2.1 item 51 record W: checkout links both the terms and a separate refund policy. The policy page is
 * /refund (Owner 2026-10-17: "同意把结账处退款政策链接改成 /refund（staging 是测试模式，正式环境开收钱另批）").
 * Production real-money checkout is still gated separately (methodCheckoutGate, R7).
 */
export const REFUND_POLICY_PATH: string | null = '/refund';
const INTERIM_TEST_REFUND_PATH = '/faq';

export const TERMS_LINKS = { terms: '/terms' } as const;

/** The refund-policy link for this entry, or null when checkout must stay closed for lack of one. */
export function refundPolicyHref(entry: Pick<MethodMembershipEntry, 'mode'> | null | undefined, policyPath = REFUND_POLICY_PATH) {
  if (policyPath) return policyPath;
  return entry?.mode === 'test' ? INTERIM_TEST_REFUND_PATH : null;
}

export const CHECKOUT_COPY = {
  unavailable: '暂时无法创建付款，请稍后查看原订单状态',
  recovery: '原来的付款页面已经不能用了。为避免重复付款，请不要重新下单，稍后到个人中心的账单记录查看这笔订单的状态。',
  badUrl: '付款页面地址异常，已停止跳转。为避免重复付款，请不要重新下单，稍后到个人中心的账单记录查看这笔订单的状态。',
  rateLimited: '下单太频繁了，请稍等一分钟再试。',
  closed: '付款暂未开放，请稍后再来。',
  termsRequired: '请先勾选同意《服务条款》和《退款政策》。',
  // Record W: a short refund line beside checkout. Record AA: the whole account must have used no credits since this
  // payment (older and gifted credits included). The 7-day window stays in the FAQ and terms.
  refundSummary: '退款说明：从这次付款起，整个账户没有用过任何积分（包括之前的和赠送的积分）才可以申请退款；续费不退款。具体条件见《退款政策》。',
  founderSoldOut: '创始会员名额刚刚售完，已改回 Gold 年付标准价，请看清价格后再付款。',
  // MASTER_PLAN §2.1 item 51 founder benefits: "终身 6 折续费" with the continuity condition, no hard-coded amount;
  // the renewal line beside the button states the current charge.
  founderRule: '创始会员终身 6 折续费（只要连续续费不中断）。取消自动续费后，权益保留到当期结束；'
    + '到期没有续费（银行卡扣款失败有 7 天宽限期），6 折续费资格结束，之后按当时的价格重新订阅，名额不再放出。',
  walletMembershipOneTime: '一次性付款，不自动续费。',
  walletFounderOneTime: '本次创始会员年付为一次性付款，不自动续费；到期前可在期限内按创始续费价格手动续买一年。',
  mainlandHint: '如果你在中国大陆，国际银行卡付款页会提示不支持；请回来改选“中国大陆银行卡”。',
} as const;

/** The entry shows only when the server says checkout is open and a terms version is published. */
export function checkoutEntryOpen(entry: MethodMembershipEntry | null | undefined): entry is MethodMembershipEntry & {
  termsVersion: string; routes: NonNullable<MethodMembershipEntry['routes']>;
} {
  return Boolean(entry && entry.checkoutReady === true && typeof entry.termsVersion === 'string'
    && entry.termsVersion.length > 0 && entry.routes && refundPolicyHref(entry) !== null);
}

/** Methods allowed by the server projection and route switches; the mainland card only sells memberships. */
export function checkoutMethods(entry: MethodMembershipEntry | null | undefined, itemType: MethodPurchase['itemType'],
  billingCycle?: MethodPurchase['billingCycle']): CheckoutMethod[] {
  if (!checkoutEntryOpen(entry)) return [];
  return entry.checkoutMethods.filter(method => {
    if (entry.routes?.[method]?.enabled !== true) return false;
    if (method === 'card_cn' && itemType !== 'membership_plan') return false;
    if ((method === 'wechat_pay' || method === 'alipay') && billingCycle === 'yearly'
      && entry.routes[method]?.annualVerified !== true) return false;
    return true;
  });
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

/** `founderIneligible`: this account already had a founder order (0222 FOUNDER_RENEWAL_REQUIRED / FOUNDER_EXPIRED);
 * the standard yearly price still applies to it. */
export type CheckoutRefusal = { message: string; goldFirstIneligible: boolean; founderSoldOut: boolean; founderIneligible: boolean };

const BUSINESS_CODES = new Set(['PRECONDITION_FAILED', 'CONFLICT', 'FORBIDDEN', 'BAD_REQUEST']);

/** Business refusals show the server's own message; outages and anything unexpected get one generic line. */
export function describeCheckoutError(error: unknown): CheckoutRefusal {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  const raw = error && typeof error === 'object' && 'message' in error ? error.message : '';
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (code === 'TOO_MANY_REQUESTS') {
    return { message: /频繁/.test(message) && message.length <= 80 ? message : CHECKOUT_COPY.rateLimited,
      goldFirstIneligible: false, founderSoldOut: false, founderIneligible: false };
  }
  // Input validation failures arrive as a JSON issue list; they are not a business answer to show.
  if (typeof code === 'string' && BUSINESS_CODES.has(code) && message && !message.startsWith('[') && message.length <= 200) {
    return { message, goldFirstIneligible: code === 'PRECONDITION_FAILED' && message.includes('首月'),
      founderSoldOut: code === 'CONFLICT' && message.includes('创始会员名额已售完'),
      founderIneligible: code === 'PRECONDITION_FAILED' && /创始会员(续费资格已过期|，请通过创始会员续费入口)|已购买过创始会员/.test(message) };
  }
  return { message: CHECKOUT_COPY.unavailable, goldFirstIneligible: false, founderSoldOut: false, founderIneligible: false };
}
