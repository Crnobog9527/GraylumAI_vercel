/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Display helpers for payment orders (PAY-COMMON PR-3). Missing or unverifiable facts are shown
 * as unknown; nothing here may turn a missing value into 0 or "no document".
 */

export type DocumentStatus = 'available' | 'unavailable' | 'unknown';
export type AmountFact = { kind: string; amount: string | null; currency: string; unit: 'major' };

type Tone = 'success' | 'muted' | 'warning';
export type DocumentStatusPresentation = { label: string; hint: string; tone: Tone };

const DOCUMENT_STATUS: Record<DocumentStatus, DocumentStatusPresentation> = {
  available: { label: '凭证可查看', hint: '可以直接打开支付渠道提供的原始凭证。', tone: 'success' },
  unavailable: { label: '没有可用凭证', hint: '支付渠道确认这笔订单没有可打开的凭证。', tone: 'muted' },
  unknown: { label: '凭证暂时无法核实', hint: '现在没能向支付渠道确认凭证情况，请稍后刷新再看。', tone: 'warning' },
};

/** Anything other than the two confirmed states reads as unknown, never as "no document". */
export function getDocumentStatusPresentation(status: string | null | undefined): DocumentStatusPresentation {
  return status === 'available' || status === 'unavailable' ? DOCUMENT_STATUS[status] : DOCUMENT_STATUS.unknown;
}

export const UNKNOWN_AMOUNT = '未知';

const AMOUNT_FACT_LABELS: Record<string, string> = {
  list_price: '标价',
  discount: '优惠',
  tax: '税费',
  paid: '实付',
  refund: '已退款',
  fee: '渠道手续费',
  net: '到账净额',
};

/** Facts a buyer should see; fee and net are merchant-side and stay on the admin view. */
export const USER_AMOUNT_FACT_KINDS = ['list_price', 'discount', 'tax', 'paid', 'refund'] as const;
/** Always shown on the admin view, as unknown when the fact is missing. */
export const ADMIN_REQUIRED_FACT_KINDS = ['paid', 'fee', 'net'] as const;

export function getAmountFactLabel(kind: string) {
  return AMOUNT_FACT_LABELS[kind] ?? kind;
}

/** Keeps the exact decimal string from the server; no float conversion, no rounding. */
export function formatAmountFact(amount: string | null | undefined, currency: string | null | undefined) {
  if (amount === null || amount === undefined || amount === '' || !currency) return UNKNOWN_AMOUNT;
  return `${currency.toUpperCase()} ${amount}`;
}

export type AmountFactRow = { kind: string; label: string; value: string };

/**
 * Rows for display. `required` kinds always appear and show unknown when the fact is missing.
 * `allowed` limits which kinds appear at all (undefined = every kind).
 */
export function buildAmountFactRows(
  facts: readonly AmountFact[] | null | undefined,
  options: { allowed?: readonly string[]; required?: readonly string[] } = {},
): AmountFactRow[] {
  const list = Array.isArray(facts) ? facts : [];
  const rows: AmountFactRow[] = [];
  const seen = new Set<string>();
  for (const fact of list) {
    if (options.allowed && !options.allowed.includes(fact.kind)) continue;
    seen.add(fact.kind);
    rows.push({ kind: fact.kind, label: getAmountFactLabel(fact.kind), value: formatAmountFact(fact.amount, fact.currency) });
  }
  for (const kind of options.required ?? []) {
    if (!seen.has(kind)) rows.push({ kind, label: getAmountFactLabel(kind), value: UNKNOWN_AMOUNT });
  }
  return rows;
}

/**
 * Formats an amount in the currency's minor unit. The divisor comes from the currency
 * (USD 2 digits, JPY 0), never a fixed 100.
 */
export function formatMinorAmount(amountMinor: number | string | null | undefined, currency: string | null | undefined) {
  if (amountMinor === null || amountMinor === undefined || amountMinor === '' || !currency) return UNKNOWN_AMOUNT;
  const minor = typeof amountMinor === 'number' ? amountMinor : Number(amountMinor);
  if (!Number.isSafeInteger(minor)) return UNKNOWN_AMOUNT;
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() });
  } catch {
    return `${currency.toUpperCase()} ${minor}（最小单位）`;
  }
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(minor / 10 ** digits);
}

export function getPaymentChannelLabel(label: string | null | undefined) {
  return label && label.trim() ? label : '未知渠道';
}
