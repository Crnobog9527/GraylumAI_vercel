/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { DECIMAL_SCALE, decimal } from './decimal';

/**
 * BILL-BYOK (Owner 2026-11-07): OpenRouter may serve an Anthropic or OpenAI call with the official key the Owner added in
 * OpenRouter (BYOK). OpenRouter's `cost` is then only its own BYOK fee; what the vendor charged is
 * `upstream_inference_cost` (https://openrouter.ai/docs/use-cases/usage-accounting). The platform's actual cost of the call
 * is the two together. A call that is not BYOK (is_byok false or absent, including a BYOK key OpenRouter fell back from)
 * keeps the cost exactly as reported, never adding the upstream field, which there only restates the same charge.
 *
 * The user's charge is not priced from this: it is the frozen list price over the token counts (nominalCost), as before.
 */
export type ByokCost = { feeUsd: string; upstreamUsd: string };
export type OpenRouterCost =
  | { kind: 'missing' } | { kind: 'invalid' }
  | { kind: 'final'; cost: string; byok?: ByokCost };

/** Where each source puts the three fields: a chat response under `usage`, the generation lookup on `data` itself. */
export function openRouterCostFields(data: Record<string, unknown>, source: 'response' | 'lookup') {
  if (source === 'lookup') return { cost: data.total_cost, isByok: data.is_byok, upstream: data.upstream_inference_cost };
  const usage = data.usage as Record<string, unknown> | undefined;
  const details = usage?.cost_details as Record<string, unknown> | undefined;
  return { cost: usage?.cost, isByok: usage?.is_byok, upstream: details?.upstream_inference_cost };
}

function format(value: bigint): string {
  const fraction = (value % DECIMAL_SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return `${value / DECIMAL_SCALE}${fraction ? `.${fraction}` : ''}`;
}

/**
 * The call's final platform cost. `exact` canonicalises one official JSON number lexeme and throws on anything the ledger
 * cannot hold. A BYOK call without the upstream amount is missing cost evidence (the recovery lookup and then the existing
 * unknown-cost rules apply), never the fee alone and never an invented price.
 */
export function resolveOpenRouterCost(fields: { cost: unknown; isByok: unknown; upstream: unknown },
  exact: (value: unknown) => string): OpenRouterCost {
  if (fields.isByok !== undefined && fields.isByok !== null && typeof fields.isByok !== 'boolean') return { kind: 'invalid' };
  if (typeof fields.cost !== 'string') return { kind: 'missing' };
  let fee: string;
  try { fee = exact(fields.cost); } catch { return { kind: 'invalid' }; }
  if (fields.isByok !== true) return { kind: 'final', cost: fee };
  if (typeof fields.upstream !== 'string') return { kind: 'missing' };
  let upstream: string;
  try { upstream = exact(fields.upstream); } catch { return { kind: 'invalid' }; }
  const total = format(decimal(fee) + decimal(upstream));
  try { decimal(total); } catch { return { kind: 'invalid' }; }
  return { kind: 'final', cost: total, byok: { feeUsd: fee, upstreamUsd: upstream } };
}

/** The receipt's usage row with the BYOK split kept beside the token counts (admin reports read actual_usd, the total). */
export function withByok(usage: Record<string, unknown>, byok: ByokCost | undefined): Record<string, unknown> {
  return byok ? { ...usage, byok: { ...byok } } : usage;
}

/**
 * The Decisions endpoint (positioning check) reports usage as plain JSON numbers. Same rule in floating point, only for that
 * platform-paid call's stop-loss share: a BYOK answer without the upstream amount is unknown (null), so the upper bound counts.
 */
export function decisionsCostUsd(usage: { cost?: unknown; is_byok?: unknown; cost_details?: unknown } | undefined): number | null {
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const fee = number(usage?.cost);
  if (fee === null) return null;
  if (usage?.is_byok === undefined || usage.is_byok === null || usage.is_byok === false) return fee;
  if (usage.is_byok !== true) return null;
  const details = usage.cost_details as Record<string, unknown> | null | undefined;
  const upstream = number(details?.upstream_inference_cost);
  return upstream === null ? null : fee + upstream;
}
