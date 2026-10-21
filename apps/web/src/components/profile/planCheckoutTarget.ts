/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { formatUsd, paywallQuote, type PaywallBilling, type PaywallPlan } from '@/components/paywall/paywallPlans';
import { CHECKOUT_COPY, GOLD_FIRST_MONTH_USD, GOLD_FOUNDER_YEAR_USD, METHOD_COPY, type CheckoutMethod } from '@/components/paywall/methodCheckout';
import type { MethodCheckoutTarget } from '@/components/paywall/MethodCheckoutDialog';
import { isOneTimeMembership, type MethodMembershipRow, type PlanAction } from './methodPlanAction';

const CYCLE: Record<PaywallBilling, string> = { monthly: '月付', yearly: '年付' };

/** The confirm dialog for a plan button; prices from the catalog, offer and upgrade from the server answers. */
export function planCheckoutTarget(input: {
  plan: PaywallPlan; billing: PaywallBilling; action: PlanAction; prior: MethodMembershipRow | null; goldFirstMonth: boolean;
  founderRenewal?: { itemId: string; subscriptionId: string; eligibleUntil: string } | null;
  /** Founder seats left from the server (0 once sold out). */
  founderSeats: number;
}): MethodCheckoutTarget | null {
  const { plan, billing, action } = input;
  if (action.kind !== 'buy' && action.kind !== 'upgrade' && action.kind !== 'founder_renewal') return null;
  const founderRenewal = action.kind === 'founder_renewal' ? input.founderRenewal : null;
  if (action.kind === 'founder_renewal' && (!founderRenewal || plan.level !== 'gold' || billing !== 'yearly')) return null;
  const firstMonth = input.goldFirstMonth && plan.level === 'gold' && billing === 'monthly';
  const founder = action.kind === 'founder_renewal' || input.founderSeats > 0 && plan.level === 'gold' && billing === 'yearly';
  const quote = paywallQuote(plan, billing, { goldFirstMonthUsd: firstMonth ? GOLD_FIRST_MONTH_USD : null,
    founderUsd: founder ? GOLD_FOUNDER_YEAR_USD : null });
  if (!quote) return null;
  const upgrade = action.kind === 'upgrade' && action.priorSubscriptionId;
  const priorSubscriptionId = founderRenewal?.subscriptionId ?? (upgrade ? action.priorSubscriptionId : null);
  const renewalDetails = founderRenewal ? [
    '本次续费为一次性付款，不自动续费；会员权益从原周期结束后接续计算。',
    `请在 ${new Date(founderRenewal.eligibleUntil).toLocaleDateString('zh-CN')} 前完成付款。`,
  ] : undefined;
  const details = upgrade ? [
    input.prior && isOneTimeMembership(input.prior) ? '原 Pro 是一次性购买，用到本期结束，不退差价。'
      : '原 Pro 订阅到本期结束后停止续费，不退差价。',
    input.prior?.billing_cycle === 'yearly' ? '已有积分全部保留，Pro 年付还没发完的积分继续按月发完。' : '已有积分全部保留。',
  ] : undefined;
  return {
    title: `${founderRenewal ? '续买 Gold' : upgrade ? '升级到 Gold' : `开通 ${plan.name}`} ${quote.founder ? '创始会员 · 年付' : CYCLE[billing]}`,
    description: founderRenewal ? '创始会员续费窗口内按原优惠年价续买一年。' : upgrade ? '付款确认后立即升级为 Gold，Gold 从付款当天起单独计费。' : '付款确认后会员立即生效。',
    purchase: { itemType: 'membership_plan', itemId: founderRenewal?.itemId ?? plan.id, billingCycle: billing,
      offer: founderRenewal ? 'founder_renewal' : firstMonth ? 'gold_first30' : quote.founder ? 'founder' : 'standard',
      ...(priorSubscriptionId ? { transition: founderRenewal ? 'founder_renewal' as const : 'upgrade' as const, priorSubscriptionId } : {}) },
    price: `${formatUsd(quote.amount)} ${quote.perLabel}`,
    renewal: founderRenewal ? `一次性付款 ${formatUsd(quote.amount)}，不自动续费。` : quote.renewal,
    cta: `${founderRenewal ? '续买一年' : '去付款'} · ${formatUsd(quote.amount)}`,
    details: renewalDetails ?? details,
    fineprint: quote.founder ? CHECKOUT_COPY.founderRule : null,
  };
}

/** Tax copy under a plan price before a method is picked: one line per offered method. */
export function methodTaxSummary(methods: readonly CheckoutMethod[]) {
  if (methods.length === 1) return METHOD_COPY[methods[0]].tax;
  return methods.map(method => `${METHOD_COPY[method].label.split(' / ')[0]}：${METHOD_COPY[method].tax}`).join('；');
}
