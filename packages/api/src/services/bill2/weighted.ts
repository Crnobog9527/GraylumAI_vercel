/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { decimal } from './decimal';
import { parseMultiplier } from '../billingUnit';

/**
 * BILL-UNIT arithmetic: every call keeps the multiplier m_i frozen for it, and an
 * operation owes N = ceil(q × Σ(cost_i × m_i)), rounded once. Costs and multipliers
 * use the BILL2 12-decimal text format; products are kept exactly (1e-24 USD units).
 */
export type WeightedCost = { readonly costUsd: string; readonly multiplier: string };

const SCALE = 1_000_000_000_000n;
const WEIGHTED_SCALE = SCALE * SCALE;
const MAX_CREDITS = 2_147_483_647n;

/** Exact W = Σ(cost_i × m_i) in 1e-24 USD units; nothing is rounded here. Each m_i must itself be a
 * valid BILL-UNIT multiplier (1–20, ≤2 decimals); callers are not trusted to have checked it. */
export function weightedUsdUnits(entries: readonly WeightedCost[]): bigint {
  return entries.reduce((sum, entry) => {
    const multiplier = decimal(parseMultiplier(entry.multiplier));
    return sum + decimal(entry.costUsd) * multiplier;
  }, 0n);
}

/** Theoretical credits N = ceil(q × W). */
export function weightedCreditsFromUnits(units: bigint, creditsPerUsd: string): number {
  const rate = decimal(creditsPerUsd);
  if (rate === 0n || units < 0n) throw new Error('BILL2_INVALID_RULES');
  const denominator = WEIGHTED_SCALE * SCALE;
  const result = (units * rate + denominator - 1n) / denominator;
  if (result > MAX_CREDITS) throw new Error('BILL2_CREDITS_OVERFLOW');
  return Number(result);
}

export function weightedAggregateCredits(entries: readonly WeightedCost[], creditsPerUsd: string): number {
  return weightedCreditsFromUnits(weightedUsdUnits(entries), creditsPerUsd);
}

/** Δ_i = ceil(q × (W + c_i × m_i)) − ceil(q × W): a cumulative difference, never a per-call ceil. */
export function weightedDeltaCredits(
  priorUnits: bigint,
  next: WeightedCost,
  creditsPerUsd: string,
): { delta: number; units: bigint } {
  const units = priorUnits + weightedUsdUnits([next]);
  const delta = weightedCreditsFromUnits(units, creditsPerUsd) - weightedCreditsFromUnits(priorUnits, creditsPerUsd);
  return { delta, units };
}

/** Lossless text form of W for frozen payloads: up to 24 fractional digits, trailing zeros trimmed. */
export function formatWeightedUsd(units: bigint): string {
  if (units < 0n) throw new Error('BILL2_INVALID_DECIMAL');
  const whole = units / WEIGHTED_SCALE;
  const fraction = (units % WEIGHTED_SCALE).toString().padStart(24, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parseWeightedUsd(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,23})(\.[0-9]{1,24})?$/.test(value)) {
    throw new Error('BILL2_INVALID_DECIMAL');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * WEIGHTED_SCALE + BigInt(fraction.padEnd(24, '0'));
}
