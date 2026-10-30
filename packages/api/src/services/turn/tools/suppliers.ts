/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { toolResultEvidence, type ToolCallPolicy } from '../../bill2/toolBilling';
import { callFirecrawl } from '../../research/vendors/firecrawl';
import { callParallel } from '../../research/vendors/parallel';
import { callTikhub } from '../../research/vendors/tikhub';
import { DEFAULT_TIMEOUT_MS } from '../../research/vendors/http';
import type { ResearchCallResult, ResearchVendor } from '../../research/vendors/types';
import type { SupplierRequest, VendorCalls } from '../../research/runtime/subcall';
import { acquireSlot, ProviderBusyError, type CounterStore } from '../limiter';
import type { SubcallReceipt } from './types';

/*
 * CORE-PATH-V2 V2-6, 3.3.2 item 10: one supplier subcall (TikHub, Parallel, Firecrawl). The supplier key is read once per turn
 * before turn_open (OR-1 fresh read, never cached across requests) and handed in. Each subcall takes one in-flight slot of its
 * supplier in the shared Redis counter (the same limiter as the model calls), waiting with backoff; with no slot, or the counter
 * unreachable, nothing is sent and the subcall is not_sent (free). A sent request is never resent or switched to another
 * supplier: a thrown adapter error after the send is an unknown result.
 */
export const VENDOR_CONCURRENCY: Readonly<Record<ResearchVendor, number>> = Object.freeze({ tikhub: 10, parallel: 5, firecrawl: 5 });
/** How long a subcall may wait for a supplier slot before it gives up unsent. */
export const SUPPLIER_SLOT_WAIT_MS = 5_000;
/** A supplier request shorter than this is not sent: it would rarely answer and may still be charged (as the old path). */
export const MIN_SUPPLIER_MS = 10_000;

const REAL_VENDORS: VendorCalls = { tikhub: callTikhub, parallel: callParallel, firecrawl: callFirecrawl };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export type SupplierDeps = {
  /** Keys read before the turn opened; a missing vendor means its slot is empty (the tool was trimmed as no_key). */
  keys: Partial<Record<ResearchVendor, string>>;
  slots: CounterStore;
  /** The frozen price of every route this turn may use (bill2 toolCallPolicy, priced at plan time). */
  policies: readonly ToolCallPolicy[];
  /** Milliseconds left in this turn for a supplier request (the reply after it keeps its own share); absent: no limit. */
  timeLeft?: () => number;
  vendors?: VendorCalls; now?: () => Date; sleep?: (ms: number) => Promise<void>; clock?: () => number;
};

const unsent = (request: SupplierRequest, reason: string, now?: () => Date): ResearchCallResult => ({
  vendor: request.vendor, route: request.route, outcome: 'not_sent', reason, httpStatus: null, supplierMayCharge: false,
  usage: { unit: request.vendor === 'tikhub' ? 'call' : request.vendor === 'parallel' ? 'sku_search' : 'credit', units: '0' },
  items: [], truncated: false, fetchedAt: (now?.() ?? new Date()).toISOString() });

function send(request: SupplierRequest, deps: { apiKey: string; timeoutMs: number; now?: () => Date }, vendors: VendorCalls) {
  if (request.vendor === 'tikhub') return vendors.tikhub(request.call, deps);
  if (request.vendor === 'parallel') return vendors.parallel(request.query, deps, request.mode);
  return vendors.firecrawl(request.url, deps);
}

/** The frozen policy of a request's route, or undefined when the turn did not price it. */
export const routePolicy = (policies: readonly ToolCallPolicy[], request: SupplierRequest) =>
  policies.find(policy => policy.provider === request.vendor && policy.model === `${request.vendor}:${request.route}`);

/** One subcall, end to end. Never throws for a supplier outcome; the receipt says what happened and what it cost. */
export async function supplierSubcall(deps: SupplierDeps, request: SupplierRequest): Promise<SubcallReceipt> {
  const policy = routePolicy(deps.policies, request);
  if (!policy) return { result: unsent(request, 'ROUTE_NOT_FROZEN', deps.now), costUsd: '0', multiplier: '1' };
  const free = (reason: string): SubcallReceipt => ({ result: unsent(request, reason, deps.now), costUsd: '0', multiplier: policy.multiplier });
  const apiKey = deps.keys[request.vendor];
  if (!apiKey) return free('KEY_MISSING');
  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.floor(deps.timeLeft?.() ?? DEFAULT_TIMEOUT_MS));
  if (timeoutMs < MIN_SUPPLIER_MS) return free('TIME_LEFT_TOO_SHORT');
  let release;
  try {
    release = await acquireSlot(deps.slots, `vendor:${request.vendor}`, { limit: VENDOR_CONCURRENCY[request.vendor],
      waitMs: SUPPLIER_SLOT_WAIT_MS, sleep: deps.sleep, now: deps.clock });
  } catch (error) {
    return free(error instanceof ProviderBusyError && error.code === 'TURN_PROVIDER_BUSY' ? 'VENDOR_BUSY' : 'VENDOR_LIMIT_UNAVAILABLE');
  }
  let result: ResearchCallResult;
  try { result = await send(request, { apiKey, timeoutMs, ...(deps.now ? { now: deps.now } : {}) }, deps.vendors ?? REAL_VENDORS); }
  catch {
    result = { ...unsent(request, 'ADAPTER_ERROR', deps.now), outcome: 'unknown', supplierMayCharge: true,
      usage: { unit: policy.toolPricing.unit, units: null } };
  } finally { await release(); }
  // The same outcome and price rules as the old receipt (bill2/toolBilling toolResultEvidence): delivered with official
  // usage is priced; a failure the supplier documents as free is 0; a per-call failure that may be billed is one call.
  // A result that names another route than the one sent cannot be priced: it stays unknown (user 0, cost for recovery).
  let evidence;
  try { evidence = toolResultEvidence('turn', policy, result, sha256(JSON.stringify(result))); }
  catch { return { result: { ...result, outcome: 'unknown', reason: 'RESULT_ROUTE_MISMATCH' }, costUsd: null, multiplier: policy.multiplier }; }
  return { result, costUsd: evidence.toolOutcome === 'unknown' ? null : evidence.cost, multiplier: policy.multiplier };
}
