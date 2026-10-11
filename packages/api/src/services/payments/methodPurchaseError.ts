/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';

type Rejection = { code: 'PRECONDITION_FAILED' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN'; message: string };

/** Expected admission refusals raised by pay_waffo_admit_purchase (0211). These are business answers,
 * not outages, so they keep a typed tRPC code and a clear message instead of the generic 503.
 * Configuration faults (catalog, price mapping, live mode) and the closed-switch gates stay out of
 * this list and remain 503. Only refusals returned by the admission RPC itself are mapped. */
const REJECTIONS: Record<string, Rejection> = {
  PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED: { code: 'PRECONDITION_FAILED',
    message: '你已有生效中的会员，不能重复购买。会员到期前无需再次付款。' },
  PAY_WAFFO_GOLD_FIRST_INELIGIBLE: { code: 'PRECONDITION_FAILED',
    message: 'Gold 首 30 天优惠仅限首次购买 Gold 的账号，你的账号不符合条件。' },
  PAY_WAFFO_PURCHASE_PENDING: { code: 'CONFLICT',
    message: '你有一笔付款还在处理中，请先完成它，或等它超时关闭后再试。' },
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

export function mapMethodPurchaseRejection(error: unknown) {
  if (!(error instanceof MethodPurchaseRejected)) return null;
  const rejection = REJECTIONS[error.message]!;
  return new TRPCError({ code: rejection.code, message: rejection.message, cause: error });
}
