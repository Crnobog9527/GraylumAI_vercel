/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';

type Rejection = { code: 'PRECONDITION_FAILED' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN'; message: string };

/** Expected admission refusals raised by pay_waffo_admit_purchase (0211). These are business answers,
 * not outages, so they keep a typed tRPC code and a clear message instead of the generic 503.
 * Configuration faults (catalog, price mapping, live mode) and the closed-switch gates stay out of
 * this list and remain 503. Only refusals returned by the admission RPC itself are mapped. */
const REJECTIONS: Record<string, Rejection> = {
  PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED: { code: 'PRECONDITION_FAILED',
    message: '你已有生效中的会员，不能重复购买。会员到期前无需再次付款。' },
  PAY_WAFFO_GOLD_FIRST_INELIGIBLE: { code: 'PRECONDITION_FAILED',
    message: 'Gold 首月优惠仅限首次购买 Gold 的账号，你的账号不符合条件。' },
  PAY_WAFFO_PURCHASE_PENDING: { code: 'CONFLICT',
    message: '你有一笔付款还在处理中，请先完成它，或等它超时关闭后再试。' },
  PAY_WAFFO_CHECKOUT_OPEN: { code: 'CONFLICT',
    message: '这笔订单的付款页面已经打开过，请回到原页面完成付款；如果已经关掉，请等约 40 分钟订单自动关闭后再重新购买。' },
  PAY_WAFFO_FOUNDER_SOLD_OUT: { code: 'CONFLICT', message: '创始会员名额已售完。' },
  PAY_WAFFO_FOUNDER_RENEWAL_REQUIRED: { code: 'PRECONDITION_FAILED',
    message: '你已购买过创始会员，请通过创始会员续费入口操作。' },
  PAY_WAFFO_FOUNDER_EXPIRED: { code: 'PRECONDITION_FAILED', message: '创始会员续费资格已过期。' },
  PAY_WAFFO_UPGRADE_WAIT: { code: 'CONFLICT',
    message: '当前会员状态暂时不能升级，请稍后再试；临近续费日时需等续费完成后再升级。' },
  PAY_WAFFO_MEMBERSHIP_REQUIRED: { code: 'PRECONDITION_FAILED', message: '积分加油包仅限会员购买。' },
  PAY_WAFFO_ACCOUNT_CLOSED: { code: 'FORBIDDEN', message: '账号已停用或正在注销，不能购买。' },
  PAY_WAFFO_OFFER_INVALID: { code: 'BAD_REQUEST', message: '这个优惠不适用于所选套餐，请刷新页面后重试。' },
  PAY_WAFFO_TRANSITION_DENIED: { code: 'BAD_REQUEST', message: '这次升级或续费请求无效，请刷新页面后重试。' },
  // Raised before checkout (cardUpgrade): a renewing prior paid another way cannot be stopped after a card upgrade.
  PAY_STRIPE_MP_UPGRADE_PRIOR_CHANNEL: { code: 'PRECONDITION_FAILED',
    message: '你现在的会员不是用银行卡开通的，暂时不能用银行卡直接升级。请提交工单，我们帮你处理升级，避免重复扣费。' },
};

/** Thrown only for a refusal the admission RPC returned; the message stays the control-flow code. */
export class MethodPurchaseRejected extends Error {
  constructor(code: string, options?: { cause?: unknown }) { super(code, options); this.name = 'MethodPurchaseRejected'; }
}

/** Database exception text is exactly the PAY_WAFFO_* code; only known refusals become typed errors. */
export function admissionError(message: unknown, cause: unknown) {
  const code = typeof message === 'string' ? message.trim() : '';
  if (Object.hasOwn(REJECTIONS, code)) return new MethodPurchaseRejected(code, { cause });
  return new Error(/^PAY_WAFFO_[A-Z_]{1,60}$/.test(code) ? code : 'PAY_WAFFO_PURCHASE_DENIED', { cause });
}

/** Same wording as the purchase page and profile notice (#937) for a subscription whose payment failed. */
export const UNPAID_SUBSCRIPTION_MESSAGE = '你还有一个付款没有成功的订阅（例如自动续费扣款失败）。为避免重复扣费，暂时不能购买新的套餐。'
  + '请提交工单，我们帮你停止这个订阅或补上付款，处理好后就能重新购买。';

/** A payment under an open dispute (chargeback) keeps its stopped subscription's period, which admission reads as a
 * membership (PR #1229 acceptance: user4 was told they already had an active membership). */
export const OPEN_DISPUTE_MESSAGE = '你有一笔付款争议（拒付）还没有处理完，处理完之前暂时不能购买新的会员。'
  + '如有疑问，请提交工单联系我们。';

/** `openDispute`: the buyer has a payment frozen by an open dispute. `unpaidSubscription`: the buyer has a subscription
 * whose payment failed (past_due, incomplete, unpaid). Admission refuses both with the same code as an active
 * membership; only the wording differs, so the buyer knows what is actually in the way. */
export function mapMethodPurchaseRejection(error: unknown,
  context: { unpaidSubscription?: boolean; openDispute?: boolean } = {}) {
  if (!(error instanceof MethodPurchaseRejected)) return null;
  const rejection = REJECTIONS[error.message]!;
  const transition = error.message === 'PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED';
  const message = transition && context.openDispute ? OPEN_DISPUTE_MESSAGE
    : transition && context.unpaidSubscription ? UNPAID_SUBSCRIPTION_MESSAGE : rejection.message;
  return new TRPCError({ code: rejection.code, message, cause: error });
}

/** Whether the buyer has a subscription whose payment failed; a failed read keeps the ordinary wording. */
export async function hasUnpaidSubscription(db: Pick<SupabaseClient, 'from'>, userId: string) {
  try {
    const result = await db.from('user_subscriptions').select('id').eq('user_id', userId)
      .in('status', ['past_due', 'incomplete', 'unpaid']).limit(1);
    return !result.error && Array.isArray(result.data) && result.data.length > 0;
  } catch { return false; }
}

/** Whether one of the buyer's payments is frozen by an open dispute; a failed read keeps the ordinary wording. */
export async function hasOpenDispute(db: Pick<SupabaseClient, 'from'>, userId: string) {
  try {
    const result = await db.from('payment_disputes').select('id,payment_orders!inner(user_id)')
      .eq('payment_orders.user_id', userId).eq('freeze_state', 'frozen').limit(1);
    return !result.error && Array.isArray(result.data) && result.data.length > 0;
  } catch { return false; }
}
