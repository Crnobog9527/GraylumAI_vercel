/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { formatUsd, paywallQuote, type PaywallBilling, type PaywallPlan } from '@/components/paywall/paywallPlans';
import { CHECKOUT_COPY, GOLD_FIRST_MONTH_USD, GOLD_FOUNDER_YEAR_USD, METHOD_COPY, type CheckoutMethod } from '@/components/paywall/methodCheckout';
import type { MethodCheckoutTarget } from '@/components/paywall/MethodCheckoutDialog';
import { isOneTimeMembership, type MethodMembershipRow, type PlanAction } from './methodPlanAction';

const CYCLE: Record<PaywallBilling, string> = { monthly: '月付', yearly: '年付' };

/** The confirm dialog for a plan button; prices from the catalog, offer and upgrade from the server answers. */
export function planCheckoutTarget(input: {
  plan: PaywallPlan; billing: PaywallBilling; action: PlanAction; prior: MethodMembershipRow | null; goldFirstMonth: boolean;
  /** Founder seats left from the server (0 once sold out). */
  founderSeats: number;
}): MethodCheckoutTarget | null {
  const { plan, billing, action } = input;
  if (action.kind !== 'buy' && action.kind !== 'upgrade') return null;
  const firstMonth = input.goldFirstMonth && plan.level === 'gold' && billing === 'monthly';
  const founder = input.founderSeats > 0 && plan.level === 'gold' && billing === 'yearly';
  const quote = paywallQuote(plan, billing, { goldFirstMonthUsd: firstMonth ? GOLD_FIRST_MONTH_USD : null,
    founderUsd: founder ? GOLD_FOUNDER_YEAR_USD : null });
  if (!quote) return null;
  const upgrade = action.kind === 'upgrade' && action.priorSubscriptionId;
  const details = upgrade ? [
    input.prior && isOneTimeMembership(input.prior) ? '原 Pro 是一次性购买，用到本期结束，不退差价。'
      : '原 Pro 订阅到本期结束后停止续费，不退差价。',
    input.prior?.billing_cycle === 'yearly' ? '已有积分全部保留，Pro 年付还没发完的积分继续按月发完。' : '已有积分全部保留。',
  ] : undefined;
  return {
    title: `${upgrade ? '升级到 Gold' : `开通 ${plan.name}`} ${quote.founder ? '创始会员 · 年付' : CYCLE[billing]}`,
    description: upgrade ? '付款确认后立即升级为 Gold，Gold 从付款当天起单独计费。' : '付款确认后会员立即生效。',
    purchase: { itemType: 'membership_plan', itemId: plan.id, billingCycle: billing,
      offer: firstMonth ? 'gold_first30' : quote.founder ? 'founder' : 'standard',
      ...(upgrade ? { transition: 'upgrade' as const, priorSubscriptionId: action.priorSubscriptionId } : {}) },
    price: `${formatUsd(quote.amount)} ${quote.perLabel}`,
    renewal: quote.renewal,
    cta: `去付款 · ${formatUsd(quote.amount)}`,
    details,
    fineprint: quote.founder ? CHECKOUT_COPY.founderRule : null,
  };
}

/** Tax copy under a plan price before a method is picked: one line per offered method. */
export function methodTaxSummary(methods: readonly CheckoutMethod[]) {
  if (methods.length === 1) return METHOD_COPY[methods[0]].tax;
  return methods.map(method => `${METHOD_COPY[method].label.split(' / ')[0]}：${METHOD_COPY[method].tax}`).join('；');
}
