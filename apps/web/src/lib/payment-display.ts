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

const DECIMAL = /^\d+(\.\d+)?$/;

/** Exact sum of two non-negative decimal strings, keeping the larger scale; null when either is not a plain decimal. */
function addDecimalAmounts(a: string, b: string) {
  if (!DECIMAL.test(a) || !DECIMAL.test(b)) return null;
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const toUnits = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
  };
  const digits = (toUnits(a) + toUnits(b)).toString().padStart(scale + 1, '0');
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function isZeroAmount(value: string) {
  return /^0+(\.0+)?$/.test(value);
}

export type TaxInclusivePaid = { total: string; tax: string; currency: string };

/**
 * Stripe Managed Payments records `paid` as the pre-tax amount and the tax it added on top as a
 * separate `tax` fact (0237, #847), so the buyer was charged paid + tax. Combined only when the order
 * has exactly one known paid value and one known tax value in the same currency; anything else
 * (several values, an unknown, mixed currencies) returns null so the separate rows stay visible.
 */
export function getTaxInclusivePaid(facts: readonly AmountFact[] | null | undefined): TaxInclusivePaid | null {
  const list = Array.isArray(facts) ? facts : [];
  const distinct = (kind: string) => {
    const seen = new Map<string, AmountFact>();
    for (const fact of list) if (fact.kind === kind) seen.set(`${fact.amount}|${fact.currency?.toLowerCase()}`, fact);
    return [...seen.values()];
  };
  const paid = distinct('paid');
  const tax = distinct('tax');
  if (paid.length !== 1 || tax.length !== 1) return null;
  const [p] = paid as [AmountFact];
  const [t] = tax as [AmountFact];
  if (!p.amount || !t.amount || !p.currency || p.currency.toLowerCase() !== t.currency?.toLowerCase()) return null;
  const total = addDecimalAmounts(p.amount, t.amount);
  return total === null ? null : { total, tax: t.amount, currency: p.currency };
}

/** Buyer rows: like buildAmountFactRows, but a Stripe pre-tax paid + tax pair reads as one tax-inclusive 实付 row. */
export function buildUserAmountFactRows(facts: readonly AmountFact[] | null | undefined): AmountFactRow[] {
  const rows = buildAmountFactRows(facts, { allowed: USER_AMOUNT_FACT_KINDS });
  const combined = getTaxInclusivePaid(facts);
  if (!combined) return rows;
  const value = formatAmountFact(combined.total, combined.currency) + (isZeroAmount(combined.tax)
    ? '' : `（含税 ${formatAmountFact(combined.tax, combined.currency)}）`);
  return rows.filter(row => row.kind !== 'tax').map(row => row.kind === 'paid' ? { ...row, value } : row);
}

/**
 * Rows for display, one per kind. `required` kinds always appear and show unknown when the fact is missing.
 * `allowed` limits which kinds appear at all (undefined = every kind).
 *
 * One order's facts all describe that order's payment, and the same payment can be recorded once per
 * provider source (a subscription's checkout session and its first invoice both record paid/fee/net).
 * Equal values therefore show once, and a known value replaces an unknown one. Different known values
 * of one kind are all kept, numbered, so a real discrepancy is never hidden.
 */
export function buildAmountFactRows(
  facts: readonly AmountFact[] | null | undefined,
  options: { allowed?: readonly string[]; required?: readonly string[] } = {},
): AmountFactRow[] {
  const list = Array.isArray(facts) ? facts : [];
  const values = new Map<string, string[]>();
  for (const fact of list) {
    if (options.allowed && !options.allowed.includes(fact.kind)) continue;
    const value = formatAmountFact(fact.amount, fact.currency);
    const known = values.get(fact.kind) ?? [];
    if (!known.includes(value)) known.push(value);
    values.set(fact.kind, known);
  }
  const rows: AmountFactRow[] = [];
  for (const [kind, all] of values) {
    const shown = all.length > 1 ? all.filter(value => value !== UNKNOWN_AMOUNT) : all;
    shown.forEach((value, index) => rows.push({
      kind,
      label: shown.length > 1 ? `${getAmountFactLabel(kind)}（第 ${index + 1} 条记录）` : getAmountFactLabel(kind),
      value,
    }));
  }
  for (const kind of options.required ?? []) {
    if (!values.has(kind)) rows.push({ kind, label: getAmountFactLabel(kind), value: UNKNOWN_AMOUNT });
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
