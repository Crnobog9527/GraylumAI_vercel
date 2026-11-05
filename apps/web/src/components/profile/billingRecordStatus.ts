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
    background: 'var(--warning-bg)',
    color: 'var(--warning)',
  },
  completed: {
    label: '已完成',
    background: 'var(--success-bg)',
    color: 'var(--success)',
  },
  failed: {
    label: '支付失败',
    background: 'var(--error-bg)',
    color: 'var(--error)',
  },
  canceled: {
    label: '已取消',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
  },
  expired: {
    label: '已过期',
    background: 'var(--error-bg)',
    color: 'var(--error)',
  },
  refunded: {
    label: '已退款',
    background: 'var(--info-bg)',
    color: 'var(--info)',
  },
  partially_refunded: {
    label: '部分退款',
    background: 'var(--info-bg)',
    color: 'var(--info)',
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
