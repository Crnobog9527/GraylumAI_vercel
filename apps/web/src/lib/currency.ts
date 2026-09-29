/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsd(amount: number) {
  return usdFormatter.format(amount);
}

/** Keep recorded micro-dollar costs visible without changing ordinary price formatting. */
export function formatReportUsd(amount: number) {
  if (!Number.isFinite(amount)) return '—';
  if (amount !== 0 && Math.abs(amount) < 1e-12) {
    return `${amount < 0 ? '-' : ''}<$0.000000000001`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 12,
  }).format(amount);
}

export function formatUsdFromCents(amountInCents: number) {
  return formatUsd(amountInCents / 100);
}
