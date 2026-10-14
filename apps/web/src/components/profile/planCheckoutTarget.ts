/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { formatUsd, paywallQuote, type PaywallBilling, type PaywallPlan } from '@/components/paywall/paywallPlans';
import { GOLD_FIRST_MONTH_USD, METHOD_COPY, type CardMethod } from '@/components/paywall/methodCheckout';
import type { MethodCheckoutTarget } from '@/components/paywall/MethodCheckoutDialog';
import type { MethodMembershipRow, PlanAction } from './methodPlanAction';

const CYCLE: Record<PaywallBilling, string> = { monthly: '月付', yearly: '年付' };

/** The confirm dialog for a plan button; prices from the catalog, offer and upgrade from the server answers. */
export function planCheckoutTarget(input: {
  plan: PaywallPlan; billing: PaywallBilling; action: PlanAction; prior: MethodMembershipRow | null; goldFirstMonth: boolean;
}): MethodCheckoutTarget | null {
  const { plan, billing, action } = input;
  if (action.kind !== 'buy' && action.kind !== 'upgrade') return null;
  const firstMonth = input.goldFirstMonth && plan.level === 'gold' && billing === 'monthly';
  const quote = paywallQuote(plan, billing, { goldFirstMonthUsd: firstMonth ? GOLD_FIRST_MONTH_USD : null });
  if (!quote) return null;
  const upgrade = action.kind === 'upgrade' && action.priorSubscriptionId;
  const details = upgrade ? [
    '原 Pro 订阅到本期结束后停止续费，不退差价。',
    input.prior?.billing_cycle === 'yearly' ? '已有积分全部保留，Pro 年付还没发完的积分继续按月发完。' : '已有积分全部保留。',
  ] : undefined;
  return {
    title: upgrade ? `升级到 Gold ${CYCLE[billing]}` : `开通 ${plan.name} ${CYCLE[billing]}`,
    description: upgrade ? '付款确认后立即升级为 Gold，Gold 从付款当天起单独计费。' : '付款确认后会员立即生效。',
    purchase: { itemType: 'membership_plan', itemId: plan.id, billingCycle: billing, offer: firstMonth ? 'gold_first30' : 'standard',
      ...(upgrade ? { transition: 'upgrade' as const, priorSubscriptionId: action.priorSubscriptionId } : {}) },
    price: `${formatUsd(quote.amount)} ${quote.perLabel}`,
    renewal: quote.renewal,
    cta: `去付款 · ${formatUsd(quote.amount)}`,
    details,
  };
}

/** Tax copy under a plan price before a method is picked: one line per offered card method. */
export function methodTaxSummary(methods: readonly CardMethod[]) {
  if (methods.length === 1) return METHOD_COPY[methods[0]].tax;
  return methods.map(method => `${METHOD_COPY[method].label.split(' / ')[0]}：${METHOD_COPY[method].tax}`).join('；');
}
