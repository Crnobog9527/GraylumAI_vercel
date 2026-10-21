/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Plan buttons on the membership page (PAY-STRIPE-MP step 5). Reads the paid memberships from
 * `payments.methodMembership`; the server still decides at checkout (an existing membership, the
 * Pro→Gold upgrade window, the Gold first month). Pro→Gold is a new Gold checkout with
 * `transition: 'upgrade'` and the Pro subscription id (#847 MIGRATION-PLAN §3).
 */
export type MethodMembershipRow = {
  subscription_id: string;
  purchase_membership_level: string;
  payment_method: string;
  billing_cycle: string;
  offer_kind: string;
  entitlement_start?: string;
  entitlement_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  /** 0214/0238: a still-renewing card subscription past its term keeps access for 24 hours while renewal is collected. */
  inGrace?: boolean;
  payment_channel?: string;
};

/** 0222 refuses an upgrade from a renewing Pro whose term ends within 48 h 31 min (wait for the renewal first). */
const UPGRADE_RENEWAL_WINDOW_MS = (48 * 60 + 31) * 60 * 1000;

const RANK: Record<string, number> = { pro: 1, gold: 2 };

/** WeChat Pay / Alipay sell one-time terms (0221: never auto_renew). 0211 stores their subscription row with
 * cancel_at_period_end=true, so `cancel_at_period_end` alone cannot tell "never renewed" from "renewal stopped". */
const ONE_TIME_METHODS = new Set(['wechat_pay', 'alipay']);
export function isOneTimeMembership(row: Pick<MethodMembershipRow, 'payment_method'>) {
  return ONE_TIME_METHODS.has(row.payment_method);
}

/** The highest paid level still in force; the server only returns memberships that have not ended. */
export function currentMethodMembership(rows: readonly MethodMembershipRow[] | null | undefined, now = Date.now()) {
  const live = (rows ?? []).filter(row => RANK[row.purchase_membership_level]
    && (!row.entitlement_start || Date.parse(row.entitlement_start) <= now)
    && (Date.parse(row.entitlement_end) > now || row.inGrace === true));
  return live.sort((a, b) => RANK[b.purchase_membership_level] - RANK[a.purchase_membership_level]
    || Date.parse(b.entitlement_end) - Date.parse(a.entitlement_end))[0] ?? null;
}

/** Append after the latest paid term, including terms not yet in force. Founder sources retain their own renewal rules. */
export function walletRenewalSource(rows: readonly MethodMembershipRow[], current: MethodMembershipRow | null) {
  if (!current || !isOneTimeMembership(current) || current.inGrace) return null;
  const latest = rows.filter(row => row.purchase_membership_level === current.purchase_membership_level)
    .sort((a, b) => Date.parse(b.entitlement_end) - Date.parse(a.entitlement_end))[0];
  return latest && isOneTimeMembership(latest) && latest.payment_channel === 'stripe'
    && !['founder', 'founder_renewal'].includes(latest.offer_kind) ? latest : null;
}

export type PlanAction =
  | { kind: 'buy' | 'upgrade' | 'founder_renewal' | 'wallet_renewal'; label: string; disabled: false; priorSubscriptionId?: string }
  | { kind: 'none'; label: string; disabled: true };

export function methodPlanAction(input: {
  level: string; price: number; checkoutReady: boolean; current: MethodMembershipRow | null;
  /** The server's entitlement level (`user.getEntitlements`); paid while a membership without a paid order
   * row here is still in force, e.g. renewal grace or an older subscription. */
  entitlementLevel?: string | null;
  now?: number;
  /** #937: an older subscription whose payment failed blocks new purchases until it is handled. */
  unpaidSubscription?: boolean;
  billingCycle?: 'monthly' | 'yearly';
  walletRenewal?: MethodMembershipRow | null;
  walletCheckoutReady?: boolean;
}): PlanAction {
  if (!RANK[input.level]) return { kind: 'none', label: '免费方案', disabled: true };
  if (!input.checkoutReady || !Number.isFinite(input.price) || input.price <= 0) {
    return { kind: 'none', label: '暂不可购买', disabled: true };
  }
  if (input.unpaidSubscription) return { kind: 'none', label: '请先处理旧订阅', disabled: true };
  const current = input.current;
  // Checkout would refuse a second membership; say so before the user picks a method and accepts terms.
  if (!current && RANK[input.entitlementLevel ?? '']) return { kind: 'none', label: '会员仍在有效期内', disabled: true };
  if (!current) return { kind: 'buy', label: '开通', disabled: false };
  if (current.inGrace) return { kind: 'none', label: '续费处理中，请稍后再看', disabled: true };
  if (current.purchase_membership_level === input.level) {
    if (isOneTimeMembership(current) && input.walletRenewal && input.walletCheckoutReady && input.billingCycle) {
      const annualSwitch = current.billing_cycle === 'monthly' && input.billingCycle === 'yearly'
        && current.subscription_id === input.walletRenewal.subscription_id;
      return { kind: 'wallet_renewal', label: annualSwitch ? '改为年付' : `提前续买${input.billingCycle === 'yearly' ? '一年' : '一个月'}`,
        disabled: false, priorSubscriptionId: input.walletRenewal.subscription_id };
    }
    return { kind: 'none', label: '当前方案', disabled: true };
  }
  if (current.purchase_membership_level === 'pro' && input.level === 'gold') {
    // A card Pro whose renewal is already stopped cannot be upgraded (0222/0251 need it still renewing);
    // Gold can be bought normally once that Pro ends. A one-time wallet Pro never renewed: 0222 admits its upgrade.
    if (current.cancel_at_period_end && !isOneTimeMembership(current)) return { kind: 'none', label: 'Pro 已停止续费，到期后可开通 Gold', disabled: true };
    // Card upgrades only: the server refuses a renewing Waffo Pro and asks for a support ticket.
    if (current.auto_renew && current.payment_channel === 'waffo') return { kind: 'none', label: '旧订阅升级请提交工单', disabled: true };
    if (current.auto_renew && Date.parse(current.entitlement_end) - (input.now ?? Date.now()) <= UPGRADE_RENEWAL_WINDOW_MS) {
      return { kind: 'none', label: '临近续费日，续费完成后可升级', disabled: true };
    }
    return { kind: 'upgrade', label: '升级到 Gold', disabled: false, priorSubscriptionId: current.subscription_id };
  }
  return { kind: 'none', label: '已是更高等级会员', disabled: true };
}

const METHOD_LABEL: Record<string, string> = {
  card: '国际银行卡', card_cn: '中国大陆银行卡', wechat_pay: '微信支付', alipay: '支付宝',
};
const LEVEL_LABEL: Record<string, string> = { pro: 'Pro', gold: 'Gold' };

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—'
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** One line per paid membership: what it is, how it was paid, and when it ends or renews. */
export function describeMethodMembership(row: MethodMembershipRow) {
  const cycle = row.billing_cycle === 'yearly' ? '年付' : row.billing_cycle === 'monthly' ? '月付' : '';
  const title = [LEVEL_LABEL[row.purchase_membership_level] ?? row.purchase_membership_level,
    row.offer_kind === 'founder' || row.offer_kind === 'founder_renewal' ? '创始会员' : null, cycle || null].filter(Boolean).join(' · ');
  const end = formatDate(row.entitlement_end);
  const status = row.inGrace ? `本期已于 ${end} 到期，正在等待续费扣款，24 小时内会员权益保留`
    : row.auto_renew ? `自动续费中，本期到 ${end}`
    : row.cancel_at_period_end && !isOneTimeMembership(row) ? `已停止续费，会员权益用到 ${end}` : `不自动续费，会员权益用到 ${end}`;
  return { title, method: METHOD_LABEL[row.payment_method] ?? '其他方式', status };
}

/** Landing-page "buy" link: /profile?tab=subscription&buy=<pro|gold>&cycle=<monthly|yearly>. Anything else is ignored. */
export { parseBuyIntent as parseBuyDeepLink } from '@/lib/buyIntent';
