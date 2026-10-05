/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { createSafeServiceUnavailableError } from '../../lib/publicError';

export function mapPurchaseCheckoutError(error: unknown, kind: 'credit_package' | 'membership_plan') {
  const reason = error instanceof Error ? error.message : '';
  if (reason === 'PAY_COMMON_ATTEMPT_EVIDENCE_UNAVAILABLE') {
    return createSafeServiceUnavailableError(error, '暂时无法核对原订单的付款结果，请稍后重试。');
  }
  if (['PAY_COMMON_ATTEMPT_NOT_TERMINAL', 'PAY_COMMON_ATTEMPT_CLOSE_FAILED'].includes(reason)) {
    return new TRPCError({ code: 'CONFLICT', message: '原订单的付款结果尚未确认，请稍后重试或在账单中查看。', cause: error });
  }
  if (['PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH', 'PAY_COMMON_RECEIPT_MISMATCH'].includes(reason)) {
    return new TRPCError({ code: 'CONFLICT', message: '原订单的付款信息不一致，请通过工单联系我们核对。', cause: error });
  }
  if (['PAY_COMMON_PRICE_MAPPING_MISSING', 'PAY_COMMON_PRICE_MAPPING_AMBIGUOUS', 'PAY_COMMON_PRICE_MISMATCH',
    'PAY_COMMON_AMOUNT_INVALID', 'PAY_COMMON_PRODUCT_UNAVAILABLE',
    'PAY_COMMON_CHANNEL_NOT_READY', 'PAY_COMMON_LIVE_PURCHASE_DISABLED', 'PAY_COMMON_CHANNEL_SETTING_INVALID'].includes(reason)) {
    return new TRPCError({ code: 'BAD_REQUEST', message: kind === 'membership_plan'
      ? '该会员套餐暂不可购买，请稍后重试' : '该商品暂不可购买，请稍后重试' });
  }
  if (['PAY_COMMON_PURCHASE_PENDING', 'PAY_COMMON_LEGACY_ORDER_UNRESOLVED',
    'PAY_COMMON_CHECKOUT_RECONCILIATION_REQUIRED'].includes(reason)) {
    return new TRPCError({ code: 'CONFLICT', message: '已有付款正在核对，请先完成原订单。', cause: error });
  }
  if (['PAY_COMMON_PURCHASE_ACTOR_DENIED', 'PAY_COMMON_MEMBERSHIP_FACTS_UNKNOWN', 'ENTITLEMENT_CONFLICT',
    'REFUNDED_ORDER_REQUIRES_POLICY', 'ACTIVE_SUBSCRIPTION_EXISTS', 'UPGRADE_DOWNGRADE_UNSUPPORTED'].includes(reason)) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: '购买资格已变化，请刷新后重试。', cause: error });
  }
  return null;
}
