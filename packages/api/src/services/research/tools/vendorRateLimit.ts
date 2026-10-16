/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pre-dispatch supplier rate limit (plan §5, §6.1 RT-3): counted per supplier + endpoint before any
// request is sent. Over the limit, or with the counter unavailable, the call becomes `budget_exhausted`:
// no request, no charge, no queueing. Adapters (RT-1) never limit themselves.
import type { ResearchVendor } from '../vendors/types';

export interface VendorLimit {
  limit: number;
  window: '1 s' | '1 m';
}

/**
 * TikHub documents 10 requests per second per endpoint by default. Parallel and Firecrawl limits depend
 * on the account plan, so these start conservative; RT-7 replaces them with the staging account's limits.
 */
export const VENDOR_RATE_LIMITS: Readonly<Record<ResearchVendor, VendorLimit>> = Object.freeze({
  tikhub: { limit: 10, window: '1 s' },
  parallel: { limit: 5, window: '1 s' },
  firecrawl: { limit: 10, window: '1 m' },
});

export type VendorCounter = (key: string, limit: number, window: VendorLimit['window']) => Promise<boolean>;

export async function admitVendorCall(
  vendor: ResearchVendor, route: string, counter: VendorCounter,
): Promise<{ ok: true } | { ok: false; reason: 'VENDOR_RATE_LIMITED' }> {
  const { limit, window } = VENDOR_RATE_LIMITS[vendor];
  let admitted = false;
  try {
    admitted = await counter(`${vendor}:${route}`, limit, window);
  } catch {
    admitted = false;
  }
  return admitted === true ? { ok: true } : { ok: false, reason: 'VENDOR_RATE_LIMITED' };
}
