/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { trpc } from '@/trpc/client';

// undefined = no provider: components keep the pre-rendered number they were given.
const LiveSeats = createContext<number | null | undefined>(undefined);

/**
 * The page is pre-rendered hourly (SEO_GEO_SPEC: public pages revalidate >= 3600), so the founder seat count is
 * refreshed once in the browser from settings.getPublicOffers. A failed or missing answer keeps the pre-rendered
 * count; a live count of 0 hides the founder blocks. It never shows a founder block the server did not render.
 */
export function FounderSeatsProvider({ initial, children }: { initial: number | null; children: ReactNode }) {
  const live = trpc.settings.getPublicOffers.useQuery(undefined, {
    enabled: initial !== null, staleTime: 60_000, retry: false, refetchOnWindowFocus: false,
  });
  const founder = live.data?.founder;
  return <LiveSeats.Provider value={founder ? founder.available : initial}>{children}</LiveSeats.Provider>;
}

/** The seats to show: the live count when a provider has one, otherwise the pre-rendered one. */
export function useFounderSeats(rendered: number | null) {
  const live = useContext(LiveSeats);
  return live === undefined ? rendered : live;
}

/** Hides its children once the live count says the founder seats are gone. */
export function FounderOnly({ children }: { children: ReactNode }) {
  return useContext(LiveSeats) === 0 ? null : <>{children}</>;
}

export function FounderSeatsLeft({ rendered, className }: { rendered: number | null; className: string }) {
  const seats = useFounderSeats(rendered);
  return seats ? <span className={className}>还剩 {seats} 个名额</span> : null;
}
