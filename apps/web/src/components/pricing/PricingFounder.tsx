/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { ReactNode } from 'react';
import { FounderSeatsLeft, FounderSeatsProvider, useFounderSeats } from '@/components/landing/offer/LiveFounderSeats';

/** Server-read public offers; a missing one is simply not shown (never a hard-coded $49 or $496). */
export type PricingOffers = {
  goldFirstMonth?: number | null;
  founder?: { price: number; total: number; available: number } | null;
};

/** Live founder seats for the page: sold out or a failed refresh hides the founder price (LiveFounderSeats). */
export function PricingOffersProvider({ offers, children }: { offers?: PricingOffers; children: ReactNode }) {
  return <FounderSeatsProvider initial={offers?.founder ? offers.founder.available : null}>{children}</FounderSeatsProvider>;
}

/** The founder price to quote on Gold yearly, or null when there is none or no seat is left. */
export function useFounderPrice(founder?: PricingOffers['founder']) {
  const seats = useFounderSeats(founder ? founder.available : null);
  return founder && founder.price > 0 && seats ? founder.price : null;
}

/** Seats left under the founder price; renders nothing once they are gone. */
export function PricingFounderSeats({ founder }: { founder?: PricingOffers['founder'] }) {
  if (!founder) return null;
  return (
    <span data-testid="pricing-founder-seats" className="text-sm font-medium" style={{ color: 'var(--warning)' }}>
      <FounderSeatsLeft rendered={founder.available} className="" />
    </span>
  );
}
