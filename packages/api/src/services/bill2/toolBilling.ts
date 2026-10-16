/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-2: the payloads a third-party search / social-data call uses on the PAYG v2 run
// (migration 0255). The host (RT-3b) freezes one policy per approved route into the run, claims each
// subcall with toolClaimPayload, and records exactly one toolResultEvidence after the supplier answers.
// The SQL side recomputes every amount from the frozen price; these helpers only have to agree with it.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResolvedProviderPrice } from '../billingProviderPrices';
import type { ResearchCallResult, ResearchUsage, ResearchVendor } from '../research/vendors/types';

export const TOOL_PROTOCOL = 'research-tool-v1';

/** The supplier's own usage unit for each vendor (RT-1 adapters); a price entry must use the same unit. */
export const VENDOR_USAGE_UNIT: Readonly<Record<ResearchVendor, ResearchUsage['unit']>> = Object.freeze({
  tikhub: 'call', parallel: 'sku_search', firecrawl: 'credit',
});

export interface ToolPricing {
  unit: ResearchUsage['unit'];
  currency: string;
  price: string;
  unitsPerPrice: string;
  usdPerCurrency: string | null;
  entryHash: string;
  validUntil: string;
  maxUnitsPerCall: string;
}

export interface ToolCallPolicy {
  provider: ResearchVendor;
  account: string;
  model: string;
  protocol: typeof TOOL_PROTOCOL;
  modelId: string;
  multiplier: string;
  lookupSupported: false;
  upperUsd: string;
  purposes: string[];
  toolPricing: ToolPricing;
}

const decimalText = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/);
/** A frozen tool-route policy as the run stores it (0255 run creation and claim checks); read back at execution. */
export const frozenToolPolicy = z.object({
  provider: z.enum(['tikhub', 'parallel', 'firecrawl']), account: z.string().min(1).max(120), model: z.string().min(1).max(160),
  protocol: z.literal(TOOL_PROTOCOL), modelId: z.string().uuid(), multiplier: z.string().min(1).max(32),
  lookupSupported: z.literal(false), upperUsd: decimalText, purposes: z.array(z.string().min(1).max(64)).min(1).max(8),
  toolPricing: z.object({
    unit: z.enum(['call', 'sku_search', 'credit']), currency: z.string().min(1).max(8), price: decimalText,
    unitsPerPrice: z.string().regex(/^[1-9][0-9]{0,8}$/), usdPerCurrency: decimalText.nullable(),
    entryHash: z.string().regex(/^[a-f0-9]{64}$/), validUntil: z.string().datetime({ offset: true }),
    maxUnitsPerCall: z.string().regex(/^[1-9][0-9]{0,5}$/),
  }).strict(),
}).strict().refine(policy => policy.modelId === toolModelId(policy.model) && policy.model.startsWith(`${policy.provider}:`)
  && VENDOR_USAGE_UNIT[policy.provider] === policy.toolPricing.unit, 'TOOL_POLICY_INVALID');

export interface ToolClaimPayload {
  provider: ResearchVendor;
  account: string;
  model: string;
  protocol: typeof TOOL_PROTOCOL;
  phase: string;
  requestHash: string;
  automaticRetry: false;
  hiddenTools: false;
  lookupSupported: false;
  upperUsd: string;
  billingUnit: { modelId: string; multiplier: string };
  toolPricing: ToolPricing;
  /** The run's owner epoch, an integer like a model call's (0167; erasure keeps it as an integer, 0184). */
  runtimeEpoch?: number;
}

export type ToolOutcome = 'delivered' | 'failed_free' | 'failed_charged' | 'unknown';

export class ToolBillingError extends Error {
  constructor(readonly code: 'TOOL_PRICE_NOT_CHARGEABLE' | 'TOOL_PRICE_EXPIRY_REQUIRED' | 'TOOL_PRICE_UNIT_MISMATCH'
    | 'TOOL_BOUND_INVALID' | 'TOOL_INPUT_INVALID' | 'TOOL_RESULT_MISMATCH' | 'TOOL_PRICE_ROUTE_MISMATCH') {
    super(code);
  }
}

/**
 * The fixed UUID standing in for a tool route's model id; equals SQL bill2_tool_model_id (0255).
 * Financial projections, including erasure, type modelId as a UUID.
 */
export function toolModelId(model: string): string {
  const hex = createHash('md5').update(`bill2-research-tool:${model}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const SCALE = 1_000_000_000_000n;
const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/;
const scaled = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, '0'));
};

/**
 * USD for `units` at a frozen price: the same exact arithmetic as providerUsageCostUsd and the SQL
 * bill2_tool_cost (0255). 'up' for the per-call bound, 'down' for an actual cost.
 */
export function toolCostUsd(pricing: ToolPricing, units: string, rounding: 'up' | 'down'): string {
  if (!DECIMAL.test(units) || !DECIMAL.test(pricing.price) || !/^[1-9][0-9]{0,8}$/.test(pricing.unitsPerPrice)) {
    throw new ToolBillingError('TOOL_INPUT_INVALID');
  }
  const rate = pricing.usdPerCurrency === null ? SCALE : scaled(pricing.usdPerCurrency);
  const numerator = scaled(units) * scaled(pricing.price) * rate;
  const denominator = SCALE * SCALE * BigInt(pricing.unitsPerPrice);
  const amount = (numerator + (rounding === 'up' ? denominator - 1n : 0n)) / denominator;
  const whole = amount / SCALE;
  if (whole >= SCALE) throw new ToolBillingError('TOOL_INPUT_INVALID');
  const fraction = (amount % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * One frozen policy for an approved route. Search prices must expire (plan §3.1) and must be charged
 * per the supplier's own unit; a price already inside another receipt cannot be charged here.
 */
export function toolCallPolicy(input: {
  vendor: ResearchVendor; account: string; route: string; purposes: string[];
  price: ResolvedProviderPrice; maxUnitsPerCall: string;
}): ToolCallPolicy {
  const { entry } = input.price;
  if (entry.includedInReceipt || entry.provider !== input.vendor) throw new ToolBillingError('TOOL_PRICE_NOT_CHARGEABLE');
  // An exact-route price belongs to that route only; a provider-wide price must really be the wide entry.
  if (input.price.matchedBy === 'route' ? entry.route !== input.route
    : entry.route !== null || !entry.appliesToUnlistedRoutes) throw new ToolBillingError('TOOL_PRICE_ROUTE_MISMATCH');
  if (entry.validUntil === null) throw new ToolBillingError('TOOL_PRICE_EXPIRY_REQUIRED');
  const unit = VENDOR_USAGE_UNIT[input.vendor];
  if (entry.usageUnit !== unit) throw new ToolBillingError('TOOL_PRICE_UNIT_MISMATCH');
  if (!/^[1-9][0-9]{0,5}$/.test(input.maxUnitsPerCall) || input.purposes.length === 0) throw new ToolBillingError('TOOL_INPUT_INVALID');
  const model = `${input.vendor}:${input.route}`;
  // A non-USD price is only as valid as its exchange rate: freeze the earlier of the two expiries.
  const validUntil = entry.fxValidUntil !== null && Date.parse(entry.fxValidUntil) < Date.parse(entry.validUntil)
    ? entry.fxValidUntil : entry.validUntil;
  const toolPricing: ToolPricing = {
    unit, currency: entry.currency, price: entry.price, unitsPerPrice: entry.unitsPerPrice,
    usdPerCurrency: entry.usdPerCurrency, entryHash: input.price.entryHash, validUntil,
    maxUnitsPerCall: input.maxUnitsPerCall,
  };
  const upperUsd = toolCostUsd(toolPricing, input.maxUnitsPerCall, 'up');
  if (!/[1-9]/.test(upperUsd)) throw new ToolBillingError('TOOL_BOUND_INVALID');
  return {
    provider: input.vendor, account: input.account, model, protocol: TOOL_PROTOCOL, modelId: toolModelId(model),
    multiplier: input.price.multiplier, lookupSupported: false, upperUsd, purposes: [...input.purposes], toolPricing,
  };
}

export function toolClaimPayload(policy: ToolCallPolicy, call: { phase: string; requestHash: string; runtimeEpoch?: number }): ToolClaimPayload {
  if (!policy.purposes.includes(call.phase) || !/^[a-f0-9]{64}$/.test(call.requestHash)) throw new ToolBillingError('TOOL_INPUT_INVALID');
  return {
    provider: policy.provider, account: policy.account, model: policy.model, protocol: TOOL_PROTOCOL,
    phase: call.phase, requestHash: call.requestHash, automaticRetry: false, hiddenTools: false, lookupSupported: false,
    upperUsd: policy.upperUsd, billingUnit: { modelId: policy.modelId, multiplier: policy.multiplier },
    toolPricing: policy.toolPricing, ...(call.runtimeEpoch !== undefined ? { runtimeEpoch: z.number().int().positive().parse(call.runtimeEpoch) } : {}),
  };
}

/**
 * The single result recorded for a dispatched call (plan §3.3, §3.4):
 *   not_sent (the adapter refused before any network call, e.g. invalid input or a non-public target,
 *     even though the call was already marked dispatched) → failed_free: nothing reached the supplier,
 *     so it settles at 0 / 0 at once and the user's hold is released;
 *   ok / partial with official usage → delivered (user pays usage × frozen price);
 *   ok / partial without usable usage → delivered without usage (user 0, supplier cost pending);
 *   failed and documented as free → failed_free; failed but chargeable → failed_charged (platform absorbs);
 *   unknown → unknown (user 0, supplier cost pending; never resent).
 */
export function toolResultEvidence(callId: string, policy: ToolCallPolicy, result: ResearchCallResult, sourceHash: string) {
  // A result paired with another subcall's policy would be priced and labelled as the wrong route.
  if (result.vendor !== policy.provider || `${result.vendor}:${result.route}` !== policy.model) {
    throw new ToolBillingError('TOOL_RESULT_MISMATCH');
  }
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new ToolBillingError('TOOL_INPUT_INVALID');
  const pricing = policy.toolPricing;
  const officialUnits = result.usage.unit === pricing.unit && result.usage.units !== null && DECIMAL.test(result.usage.units)
    ? result.usage.units : null;
  let outcome: ToolOutcome;
  let units: string | null = null;
  let cost: string | null = null;
  if (result.outcome === 'not_sent') {
    outcome = 'failed_free';
    cost = '0';
  } else if (result.outcome === 'ok' || result.outcome === 'partial') {
    outcome = 'delivered';
    units = officialUnits;
    cost = units === null ? null : toolCostUsd(pricing, units, 'down');
  } else if (result.outcome === 'failed' && !result.supplierMayCharge) {
    outcome = 'failed_free';
    cost = '0';
  } else if (result.outcome === 'failed') {
    // A per-call route charges one call; a usage route without usage cannot be priced, so it stays pending.
    units = officialUnits ?? (pricing.unit === 'call' ? '1' : null);
    outcome = units === null ? 'unknown' : 'failed_charged';
    cost = units === null ? null : toolCostUsd(pricing, units, 'down');
  } else {
    outcome = 'unknown';
  }
  return {
    provider: policy.provider, account: policy.account, protocol: TOOL_PROTOCOL, model: policy.model,
    providerId: callId, source: 'response', sourceHash, observedAt: result.fetchedAt, coverage: 'request_total',
    final: true, currency: 'USD', cost, usage: { unit: pricing.unit, units }, evidenceKind: 'tool_result',
    toolOutcome: outcome, ...(result.httpStatus !== null ? { httpStatus: result.httpStatus } : {}),
  };
}
