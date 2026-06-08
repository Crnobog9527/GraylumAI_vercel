/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

export type CreditLedgerType = 'grant' | 'spend' | 'refund_clawback' | 'adjustment' | 'expiration';

export interface CreditLedgerLike {
  amount?: number | string | null;
  type?: string | null;
  ledger_type?: string | null;
  reason_code?: string | null;
  counts_as_spend?: boolean | null;
  source_type?: string | null;
  description?: string | null;
  idempotency_key?: string | null;
}

const CREDIT_LEDGER_TYPES = new Set<CreditLedgerType>([
  'grant',
  'spend',
  'refund_clawback',
  'adjustment',
  'expiration',
]);

function toNumber(value: CreditLedgerLike['amount']): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function includesAny(value: string, needles: string[]): boolean {
  const normalizedValue = value.toLowerCase();
  return needles.some((needle) => normalizedValue.includes(needle.toLowerCase()));
}

export function isRefundClawbackLedgerEntry(row: CreditLedgerLike): boolean {
  if (row.ledger_type === 'refund_clawback') {
    return true;
  }

  const amount = toNumber(row.amount);
  if (amount >= 0) {
    return false;
  }

  const description = row.description ?? '';
  const idempotencyKey = row.idempotency_key ?? '';
  return (
    row.source_type === 'stripe_refund' ||
    idempotencyKey.startsWith('stripe_refund:') ||
    includesAny(description, [
      'refund credit clawback',
      'stripe refund',
      '退款扣回',
      '订单退款扣除积分',
    ])
  );
}

export function normalizeCreditLedgerType(row: CreditLedgerLike): CreditLedgerType {
  if (row.ledger_type && CREDIT_LEDGER_TYPES.has(row.ledger_type as CreditLedgerType)) {
    return row.ledger_type as CreditLedgerType;
  }

  if (isRefundClawbackLedgerEntry(row)) {
    return 'refund_clawback';
  }

  const amount = toNumber(row.amount);
  const type = row.type ?? '';
  const description = row.description ?? '';

  if (type === 'expiration') {
    return 'expiration';
  }

  if (
    amount < 0 &&
    (type === 'deduction' || type === 'consumption' || type === 'usage')
  ) {
    if (includesAny(description, ['管理员', 'admin', '调整', 'adjustment'])) {
      return 'adjustment';
    }
    return 'spend';
  }

  if (
    amount > 0 &&
    (type === 'addition' || type === 'purchase' || type === 'bonus' || type === 'checkin' || type === 'membership')
  ) {
    return 'grant';
  }

  return 'adjustment';
}

export function inferCreditReasonCode(row: CreditLedgerLike): string {
  if (row.reason_code?.trim()) {
    return row.reason_code;
  }

  const ledgerType = normalizeCreditLedgerType(row);
  const type = row.type ?? '';
  const description = row.description ?? '';

  if (ledgerType === 'refund_clawback') return 'refund_clawback';
  if (ledgerType === 'spend') return 'ai_task_spend';
  if (ledgerType === 'expiration') return 'expiration';

  if (ledgerType === 'grant') {
    if (type === 'purchase') return 'topup_purchase';
    if (type === 'checkin' || includesAny(description, ['签到', 'checkin'])) return 'checkin';
    if (includesAny(description, ['会员', 'invoice', 'subscription'])) return 'subscription_grant';
    return 'bonus_grant';
  }

  if (type === 'refund') return 'credit_refund';
  return 'admin_adjustment';
}

export function countsAsCreditSpend(row: CreditLedgerLike): boolean {
  const ledgerType = normalizeCreditLedgerType(row);
  if (ledgerType === 'refund_clawback') {
    return false;
  }
  if (typeof row.counts_as_spend === 'boolean') {
    return row.counts_as_spend && ledgerType === 'spend';
  }
  return ledgerType === 'spend';
}

export function countsAsTopupPurchaseCredit(row: CreditLedgerLike): boolean {
  const amount = toNumber(row.amount);
  if (amount <= 0) {
    return false;
  }

  if (row.type === 'purchase') {
    return true;
  }

  const ledgerType = normalizeCreditLedgerType(row);
  const reasonCode = inferCreditReasonCode({ ...row, ledger_type: ledgerType });
  if (ledgerType !== 'grant') {
    return false;
  }

  if (reasonCode === 'topup_purchase') {
    return true;
  }

  const description = row.description ?? '';
  return (
    row.source_type === 'stripe_checkout' &&
    includesAny(description, [
      '购买积分包',
      'credit package',
      'topup',
      'top-up',
      'top up',
    ])
  );
}

export function normalizeCreditTransactionRow<T extends CreditLedgerLike>(row: T): T & {
  ledger_type: CreditLedgerType;
  reason_code: string;
  counts_as_spend: boolean;
} {
  const ledgerType = normalizeCreditLedgerType(row);
  return {
    ...row,
    ledger_type: ledgerType,
    reason_code: inferCreditReasonCode({ ...row, ledger_type: ledgerType }),
    counts_as_spend: countsAsCreditSpend({ ...row, ledger_type: ledgerType }),
  };
}
