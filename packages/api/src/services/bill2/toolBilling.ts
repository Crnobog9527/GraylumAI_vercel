/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-2: the payloads a third-party search / social-data call uses on the PAYG v2 run
// (migration 0255). The host (RT-3b) freezes one policy per approved route into the run, claims each
// subcall with toolClaimPayload, and records exactly one toolResultEvidence after the supplier answers.
// The SQL side recomputes every amount from the frozen price; these helpers only have to agree with it.
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
  runtimeEpoch?: string;
}

export type ToolOutcome = 'delivered' | 'failed_free' | 'failed_charged' | 'unknown';

export class ToolBillingError extends Error {
  constructor(readonly code: 'TOOL_PRICE_NOT_CHARGEABLE' | 'TOOL_PRICE_EXPIRY_REQUIRED' | 'TOOL_PRICE_UNIT_MISMATCH'
    | 'TOOL_BOUND_INVALID' | 'TOOL_INPUT_INVALID' | 'TOOL_RESULT_MISMATCH') {
    super(code);
  }
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
  if (entry.validUntil === null) throw new ToolBillingError('TOOL_PRICE_EXPIRY_REQUIRED');
  const unit = VENDOR_USAGE_UNIT[input.vendor];
  if (entry.usageUnit !== unit) throw new ToolBillingError('TOOL_PRICE_UNIT_MISMATCH');
  if (!/^[1-9][0-9]{0,5}$/.test(input.maxUnitsPerCall) || input.purposes.length === 0) throw new ToolBillingError('TOOL_INPUT_INVALID');
  const model = `${input.vendor}:${input.route}`;
  const toolPricing: ToolPricing = {
    unit, currency: entry.currency, price: entry.price, unitsPerPrice: entry.unitsPerPrice,
    usdPerCurrency: entry.usdPerCurrency, entryHash: input.price.entryHash, validUntil: entry.validUntil,
    maxUnitsPerCall: input.maxUnitsPerCall,
  };
  const upperUsd = toolCostUsd(toolPricing, input.maxUnitsPerCall, 'up');
  if (!/[1-9]/.test(upperUsd)) throw new ToolBillingError('TOOL_BOUND_INVALID');
  return {
    provider: input.vendor, account: input.account, model, protocol: TOOL_PROTOCOL, modelId: model,
    multiplier: input.price.multiplier, lookupSupported: false, upperUsd, purposes: [...input.purposes], toolPricing,
  };
}

export function toolClaimPayload(policy: ToolCallPolicy, call: { phase: string; requestHash: string; runtimeEpoch?: string }): ToolClaimPayload {
  if (!policy.purposes.includes(call.phase) || !/^[a-f0-9]{64}$/.test(call.requestHash)) throw new ToolBillingError('TOOL_INPUT_INVALID');
  return {
    provider: policy.provider, account: policy.account, model: policy.model, protocol: TOOL_PROTOCOL,
    phase: call.phase, requestHash: call.requestHash, automaticRetry: false, hiddenTools: false, lookupSupported: false,
    upperUsd: policy.upperUsd, billingUnit: { modelId: policy.modelId, multiplier: policy.multiplier },
    toolPricing: policy.toolPricing, ...(call.runtimeEpoch ? { runtimeEpoch: call.runtimeEpoch } : {}),
  };
}

/**
 * The single result recorded for a dispatched call (plan §3.3, §3.4). Returns null for `not_sent`:
 * nothing reached the supplier, so the host cancels the undispatched call instead of recording one.
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
  if (result.outcome === 'not_sent') return null;
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new ToolBillingError('TOOL_INPUT_INVALID');
  const pricing = policy.toolPricing;
  const officialUnits = result.usage.unit === pricing.unit && result.usage.units !== null && DECIMAL.test(result.usage.units)
    ? result.usage.units : null;
  let outcome: ToolOutcome;
  let units: string | null = null;
  let cost: string | null = null;
  if (result.outcome === 'ok' || result.outcome === 'partial') {
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
