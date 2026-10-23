/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { TRPCError } from '@trpc/server';
import { logger } from '../../lib/logger';

const reasons: Record<string, string> = {
  PAY_REFUND_CREDITS_CONSUMED: '付款后用过积分，不符合退款条件',
  PAY_REFUND_CONSUMPTION_OR_UNKNOWN: '无法确认付款后的积分使用情况，请先核对账单',
};
/** Only exact PostgreSQL refusals in our RPC wrapper are public policy evidence. */
export function packageRefundQuoteError(error: unknown) {
  const cause = error instanceof Error && error.message === 'PAY_REFUND_RECHECK_FAILED' ? error.cause : null;
  const reason = cause && typeof cause === 'object' && 'code' in cause && cause.code === 'P0001'
    && 'message' in cause && typeof cause.message === 'string' ? cause.message : '';
  const known = Object.hasOwn(reasons, reason);
  logger.info('billing', 'package_refund_quote_refused', { code: known ? reason : 'PAY_REFUND_QUOTE_UNAVAILABLE' });
  return new TRPCError({ code: known ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
    message: known ? reasons[reason] : '退款证据不足或状态已变化，请重新核对订单与工单' });
}
