/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

export type BillingRecordStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'expired'
  | 'refunded'
  | 'partially_refunded';

type LegacyBillingRecordStatus = 'cancelled' | 'partial_refunded';

export type BillingRecordStatusLike = BillingRecordStatus | LegacyBillingRecordStatus | string | null | undefined;

type BillingRecordStatusPresentation = {
  label: string;
  background: string;
  color: string;
};

const BILLING_RECORD_STATUS_PRESENTATION: Record<BillingRecordStatus, BillingRecordStatusPresentation> = {
  pending: {
    label: '待支付',
    background: 'rgba(245, 158, 11, 0.12)',
    color: '#f59e0b',
  },
  completed: {
    label: '已完成',
    background: 'rgba(34, 197, 94, 0.12)',
    color: '#4ade80',
  },
  failed: {
    label: '支付失败',
    background: 'rgba(239, 68, 68, 0.12)',
    color: '#f87171',
  },
  canceled: {
    label: '已取消',
    background: 'rgba(148, 163, 184, 0.14)',
    color: '#cbd5e1',
  },
  expired: {
    label: '已过期',
    background: 'rgba(244, 63, 94, 0.12)',
    color: '#fb7185',
  },
  refunded: {
    label: '已退款',
    background: 'rgba(59, 130, 246, 0.12)',
    color: '#60a5fa',
  },
  partially_refunded: {
    label: '部分退款',
    background: 'rgba(168, 85, 247, 0.12)',
    color: '#c084fc',
  },
};

export function normalizeBillingRecordStatus(status: BillingRecordStatusLike): BillingRecordStatus {
  if (status === 'cancelled') {
    return 'canceled';
  }

  if (status === 'partial_refunded') {
    return 'partially_refunded';
  }

  if (typeof status === 'string' && status in BILLING_RECORD_STATUS_PRESENTATION) {
    return status as BillingRecordStatus;
  }

  return 'pending';
}

export function getBillingRecordStatusPresentation(status: BillingRecordStatusLike) {
  return BILLING_RECORD_STATUS_PRESENTATION[normalizeBillingRecordStatus(status)];
}
