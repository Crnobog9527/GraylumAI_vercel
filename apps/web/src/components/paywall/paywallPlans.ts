/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Pure pricing presentation for the paywall (PAYWALL, design v25 in docs/launch/design/paywall/).
 * Every number comes from `settings.getMembershipPlans`; nothing here invents a price or a discount.
 * The Gold first month is shown only when `payments.methodMembership` says the account is eligible;
 * the founder Gold yearly price only while the server reports founder seats left.
 */
export type PaywallBilling = 'monthly' | 'yearly';
export type PaywallLevel = 'pro' | 'gold';

/** The fields of `settings.getMembershipPlans` the paywall reads. */
export type PaywallPlanSource = {
  id: string;
  name: string;
  level: string;
  price: { monthly: number; yearly: number };
  credits: { monthly: number; monthlyBonus: number };
  discount: number;
  checkoutReady: { monthly: boolean; yearly: boolean };
};

export type PaywallPlan = PaywallPlanSource & { level: PaywallLevel };

const usable = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** One active Pro and one active Gold plan with real prices; an ambiguous catalog shows nothing for that level. */
export function pickPaywallPlans(plans: readonly PaywallPlanSource[] | undefined): PaywallPlan[] {
  return (['pro', 'gold'] as const).flatMap(level => {
    const matches = (plans ?? []).filter(plan => plan.level === level);
    if (matches.length !== 1) return [];
    const plan = matches[0];
    return usable(plan.price?.monthly) ? [{ ...plan, level }] : [];
  });
}

export function formatUsd(amount: number) {
  const cents = Math.round(amount * 100);
  return '$' + (cents % 100 === 0 ? (cents / 100).toLocaleString('en-US')
    : (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

/** Monthly credits as the plan grants them each month (base plus bonus). */
export function monthlyCredits(plan: PaywallPlanSource) {
  return Math.max(0, (plan.credits?.monthly ?? 0) + (plan.credits?.monthlyBonus ?? 0));
}

export function yearlyAvailable(plan: PaywallPlanSource) {
  return usable(plan.price?.yearly);
}

/** Whole-percent saving of yearly over 12 monthly payments, rounded down so it never overstates. */
export function yearlySavingPercent(plan: PaywallPlanSource) {
  if (!yearlyAvailable(plan)) return null;
  const twelve = plan.price.monthly * 12;
  const percent = Math.floor(((twelve - plan.price.yearly) / twelve) * 100);
  return percent > 0 ? percent : null;
}

/** Badge on the yearly switch: the best real saving among the shown plans, or nothing. While founder seats
 * remain, the founder Gold price counts too (record V: "最高省 40%", then "最高省 25%" once sold out). */
export function yearlyBadge(plans: readonly PaywallPlan[], founderUsd: number | null = null) {
  const gold = plans.find(plan => plan.level === 'gold');
  const founder = gold && usable(founderUsd) ? Math.floor(((gold.price.monthly * 12 - founderUsd!) / (gold.price.monthly * 12)) * 100) : 0;
  const best = Math.max(0, founder, ...plans.map(plan => yearlySavingPercent(plan) ?? 0));
  return best > 0 ? `最高省 ${best}%` : null;
}

export type PaywallQuote = {
  amount: number;
  perLabel: string;
  monthlyEquivalent: string | null;
  saving: string | null;
  renewal: string;
  checkoutReady: boolean;
  founder?: boolean;
};

/** Gold monthly first month and Gold yearly founder price; the caller passes each only when the server allows it. */
export type PaywallQuoteOptions = { goldFirstMonthUsd?: number | null; founderUsd?: number | null };

/** Price, renewal and cancellation text shown next to the pay button (MASTER_PLAN §2.1 item 51). */
export function paywallQuote(plan: PaywallPlan, billing: PaywallBilling, options: PaywallQuoteOptions = {}): PaywallQuote | null {
  const first = options.goldFirstMonthUsd;
  if (billing === 'monthly' && plan.level === 'gold' && usable(first) && first! < plan.price.monthly) {
    const monthly = formatUsd(plan.price.monthly);
    return { amount: first!, perLabel: '首月', monthlyEquivalent: `之后每月 ${monthly}`, saving: null,
      renewal: `首月 ${formatUsd(first!)}，之后每月自动续费 ${monthly}，可随时在个人中心取消，取消后用到当期结束。`,
      checkoutReady: plan.checkoutReady?.monthly === true };
  }
  const founder = options.founderUsd;
  if (billing === 'yearly' && plan.level === 'gold' && usable(founder) && yearlyAvailable(plan) && founder! < plan.price.yearly) {
    const price = formatUsd(founder!);
    return { amount: founder!, perLabel: '/ 年', monthlyEquivalent: `相当于 ${formatUsd(Math.floor((founder! / 12) * 100) / 100)}/月`,
      saving: `创始会员 · 比按月付 12 个月省 ${formatUsd(plan.price.monthly * 12 - founder!)}`,
      renewal: `首年 ${price}，之后每年自动续费 ${price}，可随时在个人中心取消，取消后用到当期结束。积分分 12 个月按月发放。`,
      checkoutReady: plan.checkoutReady?.yearly === true, founder: true };
  }
  if (billing === 'monthly') {
    const amount = plan.price.monthly;
    return { amount, perLabel: '/ 月', monthlyEquivalent: null, saving: null,
      renewal: `每月自动续费 ${formatUsd(amount)}，可随时在个人中心取消，取消后用到当期结束。`,
      checkoutReady: plan.checkoutReady?.monthly === true };
  }
  if (!yearlyAvailable(plan)) return null;
  const amount = plan.price.yearly;
  const saved = plan.price.monthly * 12 - amount;
  return { amount, perLabel: '/ 年', monthlyEquivalent: `相当于 ${formatUsd(Math.floor((amount / 12) * 100) / 100)}/月`,
    saving: saved > 0 ? `比按月付 12 个月省 ${formatUsd(saved)}` : null,
    renewal: `每年自动续费 ${formatUsd(amount)}，可随时在个人中心取消，取消后用到当期结束。积分分 12 个月按月发放。`,
    checkoutReady: plan.checkoutReady?.yearly === true };
}

/** Credit-pack discount as Chinese "折" (0.05 → 9.5 折); no discount reads as such, never invented. */
export function packDiscountLabel(discount: number) {
  if (!Number.isFinite(discount) || discount <= 0 || discount >= 1) return '无折扣';
  const zhe = Math.round((1 - discount) * 100) / 10;
  return `${zhe} 折`;
}

export const PLAN_FIT: Record<PaywallLevel, string> = {
  pro: '适合刚起步、先专心做好 1 个账号的人',
  gold: '适合布局多个平台、多个账号，需要多角度专业运营方案的人',
};

/** Service levels decided by the Owner (MASTER_PLAN §2.1 item 51, record Q); not read from the backend. */
export const PLAN_SUPPORT: Record<PaywallLevel, string> = { pro: '24 小时内', gold: '工作时间内 2 小时' };
export const PLAN_EARLY_ACCESS: Record<PaywallLevel, boolean> = { pro: false, gold: true };
