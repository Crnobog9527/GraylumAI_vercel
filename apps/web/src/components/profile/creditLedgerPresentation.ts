/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

export type CreditLedgerType = 'grant' | 'spend' | 'refund_clawback' | 'adjustment' | 'expiration';

export interface CreditLedgerPresentationInput {
  amount?: number | string | null;
  type?: string | null;
  ledger_type?: string | null;
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

function toNumber(value: CreditLedgerPresentationInput['amount']): number {
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

export function normalizeCreditLedgerType(row: CreditLedgerPresentationInput): CreditLedgerType {
  if (row.ledger_type && CREDIT_LEDGER_TYPES.has(row.ledger_type as CreditLedgerType)) {
    return row.ledger_type as CreditLedgerType;
  }

  const amount = toNumber(row.amount);
  const type = row.type ?? '';
  const description = row.description ?? '';
  const idempotencyKey = row.idempotency_key ?? '';

  if (
    amount < 0 &&
    (
      row.source_type === 'stripe_refund' ||
      idempotencyKey.startsWith('stripe_refund:') ||
      includesAny(description, [
        'refund credit clawback',
        'stripe refund',
        '退款扣回',
        '订单退款扣除积分',
      ])
    )
  ) {
    return 'refund_clawback';
  }

  if (type === 'expiration') {
    return 'expiration';
  }

  if (amount < 0 && (type === 'deduction' || type === 'consumption' || type === 'usage')) {
    return includesAny(description, ['管理员', 'admin', '调整', 'adjustment']) ? 'adjustment' : 'spend';
  }

  if (
    amount > 0 &&
    (type === 'addition' || type === 'purchase' || type === 'bonus' || type === 'checkin' || type === 'membership')
  ) {
    return 'grant';
  }

  return 'adjustment';
}

export function countsAsCreditSpend(row: CreditLedgerPresentationInput): boolean {
  const ledgerType = normalizeCreditLedgerType(row);
  if (ledgerType === 'refund_clawback') {
    return false;
  }
  if (typeof row.counts_as_spend === 'boolean') {
    return row.counts_as_spend && ledgerType === 'spend';
  }
  return ledgerType === 'spend';
}

export function getCreditLedgerLabel(row: CreditLedgerPresentationInput): string {
  const ledgerType = normalizeCreditLedgerType(row);
  switch (ledgerType) {
    case 'grant':
      return '积分到账';
    case 'spend':
      return 'AI 使用消耗';
    case 'refund_clawback':
      return '退款扣回';
    case 'expiration':
      return '积分过期';
    case 'adjustment':
    default:
      return '系统调整';
  }
}
