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
  entitlement_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
};

const RANK: Record<string, number> = { pro: 1, gold: 2 };

/** The highest paid level still in force; the server only returns memberships that have not ended. */
export function currentMethodMembership(rows: readonly MethodMembershipRow[] | null | undefined, now = Date.now()) {
  const live = (rows ?? []).filter(row => RANK[row.purchase_membership_level] && Date.parse(row.entitlement_end) > now);
  return live.sort((a, b) => RANK[b.purchase_membership_level] - RANK[a.purchase_membership_level]
    || Date.parse(b.entitlement_end) - Date.parse(a.entitlement_end))[0] ?? null;
}

export type PlanAction =
  | { kind: 'buy' | 'upgrade'; label: string; disabled: false; priorSubscriptionId?: string }
  | { kind: 'none'; label: string; disabled: true };

export function methodPlanAction(input: {
  level: string; price: number; checkoutReady: boolean; current: MethodMembershipRow | null;
}): PlanAction {
  if (!RANK[input.level]) return { kind: 'none', label: '免费方案', disabled: true };
  if (!input.checkoutReady || !Number.isFinite(input.price) || input.price <= 0) {
    return { kind: 'none', label: '暂不可购买', disabled: true };
  }
  const current = input.current;
  if (!current) return { kind: 'buy', label: '开通', disabled: false };
  if (current.purchase_membership_level === input.level) return { kind: 'none', label: '当前方案', disabled: true };
  if (current.purchase_membership_level === 'pro' && input.level === 'gold') {
    // A card Pro whose renewal is already stopped cannot be upgraded (0222/0251 need it still renewing);
    // Gold can be bought normally once that Pro ends.
    if (current.cancel_at_period_end) return { kind: 'none', label: 'Pro 已停止续费，到期后可开通 Gold', disabled: true };
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
    row.offer_kind === 'founder' ? '创始会员' : null, cycle || null].filter(Boolean).join(' · ');
  const end = formatDate(row.entitlement_end);
  const status = row.auto_renew ? `自动续费中，本期到 ${end}`
    : row.cancel_at_period_end ? `已停止续费，会员权益用到 ${end}` : `不自动续费，会员权益用到 ${end}`;
  return { title, method: METHOD_LABEL[row.payment_method] ?? '其他方式', status };
}
