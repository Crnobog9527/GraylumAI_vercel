/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { trpc } from '@/trpc/client';

/** A plan as `settings.getMembershipPlans` returns it: `discount` is the fraction off credit packs (0.1 = 10% off). */
type PlanDiscount = { level: string; discount: number };

export type CreditPackagePrice = { payableUsd: number; listUsd: number; discounted: boolean };

/**
 * The price a user pays for a credit pack, mirroring checkout (0173 pay_common purchase):
 * a member pays round(list_cents * package_discount / 100) of their level's active plan; free users pay the list price.
 * When the discount cannot be read unambiguously the list price is shown, so no discount is ever invented.
 */
export function getCreditPackagePrice(listUsd: number, level: string | null | undefined,
  plans: readonly PlanDiscount[] | null | undefined): CreditPackagePrice {
  const list = { payableUsd: listUsd, listUsd, discounted: false };
  if (!Number.isFinite(listUsd) || listUsd <= 0 || !level || level === 'free') return list;
  const discounts = new Set((plans ?? []).filter(plan => plan.level === level).map(plan => plan.discount));
  if (discounts.size !== 1) return list;
  const [off] = discounts;
  if (typeof off !== 'number' || !Number.isFinite(off) || off <= 0 || off >= 1) return list;
  const listCents = Math.round(listUsd * 100);
  const packageDiscount = Math.round(100 - off * 100);
  // Integer half-up rounding, as Postgres round(numeric) does for positive amounts.
  const payableCents = Math.floor((listCents * packageDiscount + 50) / 100);
  if (payableCents <= 0 || payableCents >= listCents) return list;
  return { payableUsd: payableCents / 100, listUsd, discounted: true };
}

export function formatUsd(amount: number) {
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '—';
}

/** The price a credit pack card shows: what this user pays, with the real list price struck through when discounted. */
export function CreditPackagePriceTag({ listUsd, membershipLevel }: { listUsd: number; membershipLevel?: string | null }) {
  const { data: plans } = trpc.settings.getMembershipPlans.useQuery();
  const price = getCreditPackagePrice(listUsd, membershipLevel, plans);
  return (
    <div data-testid="profile-credit-package-price" className="text-lg font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
      {formatUsd(price.payableUsd)}
      {price.discounted && (
        <del data-testid="profile-credit-package-list-price" className="ml-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          <span className="sr-only">原价</span>{formatUsd(price.listUsd)}
        </del>
      )}
    </div>
  );
}
