/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-3b: one supplier subcall, end to end (plan §2.4, §3.2–3.4, §4.3, §6.1).
// Order: route and frozen price → key → supplier rate limit → BILL2 claim (hold) → evidence record (bound to the
// answer, reserved only) → evidence↔call link → BILL2 dispatch → research dispatch → supplier → evidence result →
// BILL2 tool_result. The research side is dispatched last (#1005 P2): an operation is never left dispatched
// without its BILL2 link, and an unsent one is cancelled so a stable discovery cursor can move to a successor.
// Nothing is sent unless every earlier step passed. A sent request is never resent or switched to another supplier.
import { createHash } from 'node:crypto';
import { BillingClaimRejection } from '../../bill2/claimFailure';
import { toolClaimPayload, toolResultEvidence, type ToolCallPolicy } from '../../bill2/toolBilling';
import type { ToolSubcallBilling } from '../../bill2/toolSubcall';
import { callFirecrawl } from '../vendors/firecrawl';
import { callParallel, type ParallelMode } from '../vendors/parallel';
import { callTikhub, type TikhubCall } from '../vendors/tikhub';
import type { ResearchCallResult, ResearchVendor } from '../vendors/types';
import { admitVendorCall, type VendorCounter } from '../tools/vendorRateLimit';
import type { SecretReader } from './secrets';

/** What one subcall asked for, as the user sees it (charges, evidence and the research_call event). */
export interface ResearchCallDisplay { query: string; platform: string; dataKind: string }

export type SupplierRequest =
  | { vendor: 'tikhub'; route: string; call: TikhubCall }
  | { vendor: 'parallel'; route: string; query: string; mode: ParallelMode }
  | { vendor: 'firecrawl'; route: string; url: string };

export interface VendorCalls {
  tikhub: typeof callTikhub;
  parallel: typeof callParallel;
  firecrawl: typeof callFirecrawl;
}
const REAL_VENDORS: VendorCalls = { tikhub: callTikhub, parallel: callParallel, firecrawl: callFirecrawl };

/** Host-owned evidence for one subcall: a research operation bound to the answer at creation (0263). */
export interface EvidencePort {
  /** Creates the bound plan and reserves its operation (still prepared); null = it must not be sent. */
  open(operationId: string, identityHash: string, quoteUnits: number): Promise<{ token: string } | null>;
  /** Marks the reserved operation dispatched, immediately before the supplier send; false = it must not be sent. */
  dispatch(operationId: string, token: string): Promise<boolean>;
  finish(operationId: string, token: string, state: 'succeeded' | 'failed' | 'unknown', result: unknown): Promise<void>;
  link(operationId: string, callId: string): Promise<void>;
  /** Cancels an operation that was never dispatched on the research side (nothing was sent). */
  cancel(operationId: string): Promise<void>;
}

export interface SubcallContext {
  policies: readonly ToolCallPolicy[];
  billing: ToolSubcallBilling;
  evidence: EvidencePort;
  /** The run's next free BILL2 sequence; model calls and subcalls share one contiguous sequence (0162). */
  nextSequence: () => number | Promise<number>;
  phase: string;
  runtimeEpoch?: number;
  secrets: SecretReader;
  rateCounter: VendorCounter;
  vendors?: VendorCalls;
  newId: () => string;
  now?: () => Date;
  metadata?: { toolName: string; args: Record<string, unknown>; call?: ResearchCallDisplay };
  beforeSend?: () => Promise<boolean>;
  onSupplierDispatch?: () => void;
}

/** Why nothing (or nothing usable) came back, as the tool envelope reports it. */
export type SubcallStop = 'KEY_MISSING' | 'KEY_UNAVAILABLE' | 'ROUTE_NOT_FROZEN' | 'VENDOR_RATE_LIMITED' | 'CALL_REPLAYED'
  | 'NOT_DISPATCHED' | 'ACCOUNT_CLOSED' | 'CONTENT_DELETED' | `CLAIM_${string}`;

export type SubcallOutcome =
  | { sent: true; result: ResearchCallResult; operationId: string; callId: string }
  | { sent: false; stop: SubcallStop; budget: boolean };

/**
 * The balance cannot start this subcall (BILL-PAYG, plan §2.1 2026-10-01): nothing was held or sent. The turn pauses at
 * this slot (payg_wait) and the same request claims it again after a top-up; it is never skipped or reported as a failure.
 */
export class ResearchWaitingCredits extends Error {
  constructor(readonly point: { sequence: number; requestHash: string; phase: string }) { super('RUNTIME_WAITING_CREDITS'); }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The request identity shared by the BILL2 call (requestHash) and its evidence operation (identity_hash). */
export function requestIdentity(request: SupplierRequest): string {
  const body = request.vendor === 'tikhub' ? request.call
    : request.vendor === 'parallel' ? { query: request.query, mode: request.mode } : { url: request.url };
  return sha256(JSON.stringify({ vendor: request.vendor, route: request.route, body }));
}

function microUnits(usd: string): number {
  const [whole, fraction = ''] = usd.split('.');
  return Number(whole) * 1_000_000 + Math.ceil(Number(`0.${fraction || '0'}`) * 1_000_000);
}

const OPERATION_STATE = { ok: 'succeeded', partial: 'succeeded', failed: 'failed', not_sent: 'failed', unknown: 'unknown' } as const;

async function send(request: SupplierRequest, apiKey: string, vendors: VendorCalls, now?: () => Date): Promise<ResearchCallResult> {
  const deps = { apiKey, ...(now ? { now } : {}) };
  if (request.vendor === 'tikhub') return vendors.tikhub(request.call, deps);
  if (request.vendor === 'parallel') return vendors.parallel(request.query, deps, request.mode);
  return vendors.firecrawl(request.url, deps);
}

/** A thrown adapter error after dispatch is an unknown result: it may have reached the supplier. */
function unknownResult(request: SupplierRequest, vendor: ResearchVendor, now?: () => Date): ResearchCallResult {
  const unit = vendor === 'tikhub' ? 'call' : vendor === 'parallel' ? 'sku_search' : 'credit';
  return { vendor, route: request.route, outcome: 'unknown', reason: 'ADAPTER_ERROR', httpStatus: null, supplierMayCharge: true,
    usage: { unit, units: null }, items: [], truncated: false, fetchedAt: (now?.() ?? new Date()).toISOString() };
}

export async function runSubcall(context: SubcallContext, request: SupplierRequest): Promise<SubcallOutcome> {
  const policy = context.policies.find(item => item.provider === request.vendor && item.model === `${request.vendor}:${request.route}`);
  if (!policy) return { sent: false, stop: 'ROUTE_NOT_FROZEN', budget: false };
  // Before any claim: a missing or unreadable key sends nothing and charges nothing (ADMIN-SECRETS §10 RT).
  let apiKey: string | null;
  try { apiKey = await context.secrets(request.vendor); }
  catch { return { sent: false, stop: 'KEY_UNAVAILABLE', budget: false }; }
  if (!apiKey) return { sent: false, stop: 'KEY_MISSING', budget: false };
  const limited = await admitVendorCall(request.vendor, request.route, context.rateCounter);
  if (!limited.ok) return { sent: false, stop: 'VENDOR_RATE_LIMITED', budget: true };

  const identity = requestIdentity(request);
  let claim;
  const sequence = await context.nextSequence();
  try {
    claim = await context.billing.claim(sequence, toolClaimPayload(policy, {
      phase: context.phase, requestHash: identity, ...(context.runtimeEpoch !== undefined ? { runtimeEpoch: context.runtimeEpoch } : {}),
    }));
  } catch (error) {
    if (error instanceof BillingClaimRejection) return { sent: false, stop: `CLAIM_${error.reason}`, budget: false };
    throw error;
  }
  if (claim.state === 'waiting_credits') throw new ResearchWaitingCredits({ sequence, requestHash: identity, phase: context.phase });
  if (claim.state === 'replayed') return { sent: false, stop: 'CALL_REPLAYED', budget: false };

  const operationId = context.newId();
  const opened = await context.evidence.open(operationId, identity, microUnits(policy.upperUsd));
  // The claimed call stays undispatched (never sent); the run releases its hold when it closes.
  if (!opened) return { sent: false, stop: 'NOT_DISPATCHED', budget: false };
  let result: ResearchCallResult;
  let preSendError: unknown;
  let permitted = false;
  // 'no' = provably still prepared; 'maybe' = the dispatch request may have committed before failing.
  let researchDispatched: 'no' | 'yes' | 'maybe' = 'no';
  let unsentReason = 'FETCH_NOT_DISPATCHED';
  try {
    // Bind before any supplier dispatch so recovery and erasure can identify this call.
    await context.evidence.link(operationId, claim.callId);
    if (!await context.billing.dispatch(claim.callId, claim.token)) {
      await context.evidence.cancel(operationId);
      return { sent: false, stop: 'NOT_DISPATCHED', budget: false };
    }
    researchDispatched = 'maybe';
    if (await context.evidence.dispatch(operationId, opened.token)) {
      researchDispatched = 'yes';
      permitted = await context.beforeSend?.() ?? true;
      if (permitted) context.onSupplierDispatch?.();
    } else {
      researchDispatched = 'no';
      unsentReason = 'NOT_DISPATCHED';
    }
  } catch (error) {
    permitted = false;
    preSendError = error;
    unsentReason = 'LOCAL_PRE_SEND_FAILED';
  }
  if (!permitted) {
    result = { ...unknownResult(request, request.vendor, context.now), outcome: 'not_sent',
      reason: unsentReason, supplierMayCharge: false, usage: { unit: policy.toolPricing.unit, units: '0' } };
  } else {
    try { result = await send(request, apiKey, context.vendors ?? REAL_VENDORS, context.now); }
    catch { result = unknownResult(request, request.vendor, context.now); }
  }

  const evidence = toolResultEvidence(claim.callId, policy, result, sha256(JSON.stringify(result)));
  let storageError: unknown;
  if (researchDispatched !== 'no') {
    try { await context.evidence.finish(operationId, opened.token, OPERATION_STATE[result.outcome], {
      vendor: result.vendor, route: result.route, outcome: result.outcome, reason: result.reason, fetchedAt: result.fetchedAt,
      items: result.items, truncated: result.truncated, usage: result.usage,
      httpStatus: result.httpStatus, supplierMayCharge: result.supplierMayCharge, ...context.metadata,
      cost: { actual: evidence.cost === null ? null : Number(evidence.cost) },
      billing: { runId: context.billing.runId, callId: claim.callId, receipt: evidence },
    }); } catch (error) { storageError = error; }
  }
  // Nothing was sent and the operation may still be prepared: cancel it so it is never sent later.
  if (!permitted && (researchDispatched === 'no' || (researchDispatched === 'maybe' && storageError))) {
    try { await context.evidence.cancel(operationId); storageError = undefined; }
    catch (error) { storageError ??= error; }
  }
  // A storage outage must not discard known supplier cost. Persist the financial receipt even when evidence failed.
  const receipt = storageError && evidence.toolOutcome === 'delivered'
    ? { ...evidence, toolOutcome: evidence.cost === null ? 'unknown' as const : 'failed_charged' as const } : evidence;
  const saved = await context.billing.record(claim.callId, receipt);
  if (storageError) throw storageError;
  if (preSendError) throw preSendError;
  if (saved.accountClosed) return { sent: false, stop: 'ACCOUNT_CLOSED', budget: false };
  if (saved.contentDeleted) return { sent: false, stop: 'CONTENT_DELETED', budget: false };
  if (!permitted && unsentReason === 'NOT_DISPATCHED') return { sent: false, stop: 'NOT_DISPATCHED', budget: false };
  return { sent: true, result, operationId, callId: claim.callId };
}
