/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

function minorAmount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('PAY_COMMON_REFUND_AMOUNT_INVALID');
  return BigInt(value);
}

// All inputs are authoritative amounts already expressed in the SAME currency's
// smallest unit. No catalog price, currency conversion or configurable fee here.
export function calculateRefundMoney(input: {
  paidMinor: number;
  refundedMinor: number;
  basisMinor: number;
}) {
  const paid = minorAmount(input.paidMinor);
  const refunded = minorAmount(input.refundedMinor);
  const basis = minorAmount(input.basisMinor);
  if (paid === 0n || basis === 0n || refunded > paid || basis > paid) {
    throw new Error('PAY_COMMON_REFUND_AMOUNT_INVALID');
  }
  const fee = basis * 6n / 100n;
  const net = basis - fee;
  if (net > paid - refunded) throw new Error('PAY_COMMON_REFUND_EXCEEDS_REMAINING');
  return { basisMinor: Number(basis), feeMinor: Number(fee), netMinor: Number(net),
    remainingMinor: Number(paid - refunded) };
}

// PostgreSQL ticket timestamps can have microseconds. Do not round a request
// just AFTER the 168-hour deadline back onto the eligible boundary.
export function refundTime(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|\+00:00)$/.exec(value);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) return null;
  return BigInt(ms) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

export const REFUND_WINDOW_MICROSECONDS = 168n * 60n * 60n * 1000000n;
