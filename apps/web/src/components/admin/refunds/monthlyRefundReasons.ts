/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Plain-Chinese text for the reason codes `admin.quoteMonthlyRefund` returns since #750
 * (packages/api/src/services/payments/monthlyRefundError.ts). `ineligible` is only for codes that
 * mean exactly one checked-and-failed refund rule (refundPolicy's `rejected` outcomes, or a refund or
 * dispute the provider reports), where rejecting is the normal next step. A code that can also come
 * from missing or mismatched evidence (checked against migrations 0193–0195) needs checking first.
 * Unknown codes fall back to the generic text.
 */
type Reason = { text: string; ineligible?: true };

const RULE = (text: string): Reason => ({ text, ineligible: true });
const CHECK = (text: string): Reason => ({ text });

const REASONS: Record<string, Reason> = {
  PAY_REFUND_OUTSIDE_WINDOW: RULE('已超过付款后 7 天的退款期限'),
  // 0193: also missing, future or mismatched payment/ticket times, not only a late request.
  PAY_REFUND_WINDOW: CHECK('付款或工单时间不在 7 天范围内，或者时间记录缺失、对不上'),
  PAY_REFUND_CREDITS_CONSUMED: RULE('从这次付款起，这个账户用过积分'),
  PAY_REFUND_NOT_FIRST_PURCHASE: RULE('不是第一次购买会员'),
  PAY_REFUND_RENEWAL: RULE('这是续费，续费不退款'),
  PAY_REFUND_PRIOR_REFUND_OR_DISPUTE: RULE('这笔付款已经有退款或争议（拒付）记录，不能再退'),
  // monthlyRefundApproval: also channel, mode, refund reason or account state, not only the product.
  PAY_REFUND_MONTHLY_SCOPE_REQUIRED: CHECK('这笔订单可能不是 Pro 或 Gold 月付首购，或者渠道、模式、账户状态不符合'),
  PAY_MONTHLY_SCOPE_OR_STATE: CHECK('这笔订单不是 Pro 或 Gold 月付首购，或者订单、订阅状态不允许退款'),
  PAY_REFUND_SCOPE_MISMATCH: CHECK('订单的退款范围和这里处理的不一致'),
  PAY_REFUND_TEST_SUBSCRIPTION_ONLY: CHECK('目前只能处理测试模式（Stripe 沙盒）的订阅'),
  PAY_REFUND_CONSUMPTION_UNRESOLVED: CHECK('暂时无法确认这次付款后有没有用过积分'),
  PAY_REFUND_CONSUMPTION_OR_UNKNOWN: CHECK('这次付款后可能用过积分，或者暂时无法确认'),
  PAY_REFUND_MEMBERSHIP_HISTORY_UNRESOLVED: CHECK('会员购买记录不完整，无法确认是不是第一次购买'),
  PAY_MONTHLY_HISTORY: CHECK('会员购买记录不完整，无法确认是不是第一次购买'),
  PAY_REFUND_HISTORY_INCOMPLETE: CHECK('购买记录不完整'),
  PAY_REFUND_PURCHASE_KIND_UNRESOLVED: CHECK('无法确认这笔订单的购买类型'),
  PAY_REFUND_BINDING_MISMATCH: CHECK('订单、订阅和发放的积分对不上'),
  PAY_REFUND_EVIDENCE_IDENTITY_MISMATCH: CHECK('订单、用户和支付记录对不上'),
  PAY_REFUND_EVIDENCE_TIME_MISMATCH: CHECK('付款时间或工单时间和记录对不上'),
  PAY_REFUND_SUBSCRIPTION_PERIOD_UNRESOLVED: CHECK('订阅当前的计费周期无法确认，可能已经到期'),
  PAY_REFUND_EVIDENCE_INCOMPLETE: CHECK('退款需要的证据不完整'),
  PAY_MONTHLY_PROVIDER_EVIDENCE: CHECK('支付商那边的记录不完整'),
  PAY_REFUND_INVALID_PAYMENT_AMOUNT: CHECK('付款金额异常'),
  PAY_MONTHLY_AMOUNT: CHECK('付款金额异常'),
  PAY_MONTHLY_CASH: CHECK('实际收款记录对不上'),
  PAY_REFUND_INVALID_AMOUNT: CHECK('算出来的退款金额不合法'),
  PAY_REFUND_FEE_REQUIRES_REVIEW: CHECK('手续费需要人工核对'),
  PAY_REFUND_FEE_EVIDENCE_REQUIRED: CHECK('需要填写手续费的核对依据'),
  PAY_REFUND_SETTLEMENT_UNRESOLVED: CHECK('付款结算状态还没确认'),
  PAY_REFUND_GRANT_UNRESOLVED: CHECK('这次付款发放的积分记录无法确认'),
  PAY_REFUND_GRANTS_UNRESOLVED: CHECK('这次付款发放的积分记录无法确认'),
  PAY_REFUND_VERSION: CHECK('订单或工单刚刚有变化，请重新获取报价'),
  PAY_REFUND_STALE_PREVIEW: CHECK('订单或工单刚刚有变化，请重新获取报价'),
  PAY_REFUND_STALE_APPROVAL: CHECK('批准之后订单或工单有变化，请重新获取报价'),
  PAY_REFUND_EVIDENCE_CHANGED: CHECK('核对用的记录刚刚有变化，请重新获取报价'),
  PAY_REFUND_ADMIN_REQUIRED: CHECK('当前账号不是有效的管理员'),
  PAY_REFUND_SUBJECT_UNAVAILABLE: CHECK('用户账号状态不可用（可能已注销或停用）'),
  PAY_REFUND_TICKET_MISMATCH: CHECK('工单不是这位用户的账单类工单'),
  PAY_REFUND_ORDER_UNKNOWN: CHECK('找不到这笔订单，请核对订单编号'),
  PAY_REFUND_ORDER_UNAVAILABLE: CHECK('这笔订单现在读不到'),
  PAY_REFUND_MAPPING_UNRESOLVED: CHECK('订单和支付商订阅的对应关系无法确认'),
  PAY_REFUND_PROVIDER_HISTORY_INCOMPLETE: CHECK('支付商的历史记录不完整，暂时无法核对'),
  PAY_REFUND_PROVIDER_HISTORY_UNRESOLVED: CHECK('支付商的历史记录暂时无法确认'),
  PAY_REFUND_INVOICE_MISMATCH: CHECK('账单记录对不上'),
  PAY_REFUND_INVOICE_MISSING: CHECK('找不到对应的账单'),
  PAY_REFUND_INVOICE_PAYMENT_UNRESOLVED: CHECK('账单的付款状态无法确认'),
  PAY_REFUND_INVOICE_PAYMENT_MISMATCH: CHECK('账单和付款记录对不上'),
  PAY_REFUND_PAYMENT_MISMATCH: CHECK('付款记录对不上'),
  PAY_REFUND_CHARGE_MISMATCH: CHECK('扣款记录对不上'),
  PAY_REFUND_PAYMENT_ORDER_UNRESOLVED: CHECK('付款和订单的对应关系无法确认'),
  PAY_REFUND_PAYMENT_TIME_UNRESOLVED: CHECK('付款时间无法确认'),
  // Status and reject answers since #759 (table in #759 comment 6084918439).
  PAY_REFUND_STATUS_UNAVAILABLE: CHECK('暂时无法读取退款进度，请稍后再试'),
  PAY_REFUND_REJECT_UNAVAILABLE: CHECK('暂时无法完成操作，请先查看进度再决定下一步'),
  PAY_MONTHLY_REJECTION_INVALID: CHECK('订单范围、工单或拒绝原因不符合要求，请重新核对'),
  PAY_REFUND_ALREADY_DISPATCHED: CHECK('这笔退款已经开始执行，或者已有的退款记录类型不同，不能在这里拒绝'),
};

/** Codes that alone prove a refund rule failed; everything else needs a person to check first. */
export const INELIGIBLE_REFUND_CODES = Object.keys(REASONS).filter(code => REASONS[code].ineligible).sort();

export type QuoteRefusal = { text: string; specific: boolean; ineligible: boolean };

/** The refusal shown under "获取报价"; never the raw code, never server text that is not mapped. */
export function monthlyRefundQuoteRefusal(error: unknown, fallback: string): QuoteRefusal {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const reason = Object.hasOwn(REASONS, code) ? REASONS[code] : null;
  if (!reason) return { text: fallback, specific: false, ineligible: false };
  return { text: reason.text, specific: true, ineligible: reason.ineligible === true };
}

/** Plain text for a known code from any refund call (status, reject, quote); null for anything else. */
export function monthlyRefundCodeText(error: unknown): string | null {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return Object.hasOwn(REASONS, code) ? REASONS[code].text : null;
}
