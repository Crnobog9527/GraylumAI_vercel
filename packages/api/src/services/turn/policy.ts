/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { NominalPricing } from '../../shared/nominalPricing';

/*
 * CORE-PATH-V2 2.5 / 2.5.3: the numbers a turn freezes at turn_open, computed from the catalog cache (q, the model multiplier m,
 * the call bound U, the call limits, the stop-loss parameters). One model call costs the user at most G = ceil(q x U x m) credits;
 * every tool return makes the model run once more, so M = 1 + paid tools + free tools model calls. G_turn = M x G_model + sum of
 * the paid tools' G, and U_turn (USD, the stop-loss reservation) is the same sum without q and m. The positioning check (Decisions)
 * is outside M (Fable 10-28): never charged to the user, so not in G, but its real upper bound is in U_turn. Exact decimals.
 */
const SCALE = 12n, ONE = 10n ** SCALE;
const decimal = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,12})?$/);
const units = (value: string) => {
  const [whole, fraction = ''] = decimal.parse(value).split('.');
  return BigInt(whole!) * ONE + BigInt(fraction.padEnd(Number(SCALE), '0'));
};
const format = (value: bigint) => {
  const whole = value / ONE, fraction = (value % ONE).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
};
/** ceil(q x U x m) in credits for one call. */
export function callCredits(q: string, upperUsd: string, multiplier: string): number {
  const product = units(q) * units(upperUsd) * units(multiplier), denominator = ONE * ONE * ONE;
  return Number((product + denominator - 1n) / denominator);
}

export const turnLimits = z.object({ model: z.number().int().min(1).max(16), paidTools: z.number().int().min(0).max(8),
  freeTools: z.number().int().min(0).max(8), decisions: z.number().int().min(0).max(1),
  /** Receipt rows paidTools may use (a benchmark call settles in batches); absent: one row per call. Adds no model call. */
  toolRows: z.number().int().min(1).max(16).optional(),
  /** A resume whose first model call is answered by its receipt (resume.ts): that call is not a call this turn makes. */
  replayedModels: z.number().int().min(0).max(1).optional() }).strict()
  .refine(l => l.model + (l.replayedModels ?? 0) >= 1 + l.paidTools + l.freeTools, 'every tool return is one more model call (2.5.3)');
export type TurnLimits = z.infer<typeof turnLimits>;
export const stopLossSettings = z.object({ limitUsd: z.number().positive(), p: z.number().int().min(1),
  poolSize: z.number().int().min(1), uFastUsd: z.number().nonnegative(), uBigUsd: z.number().nonnegative() }).strict();

export type PolicyInput = {
  q: string; multiplier: string; modelUpperUsd: string; limits: TurnLimits;
  /** One bound per allowed paid tool call (research), in USD; the tool's own multiplier is the model's here. */
  paidToolUpperUsd?: readonly string[];
  /** Model calls on another model, each with its own bound in USD and multiplier (the mentor's organizer, V2-5). They are in
   * limits.model beyond the 1 + tools of the main model: limits.model = 1 + paidTools + freeTools + otherModelCalls.length. */
  otherModelCalls?: ReadonlyArray<{ upperUsd: string; multiplier: string }>;
  /** The Decisions model's upper bound for one positioning check, in USD; required when limits.decisions is 1. */
  decisionUpperUsd?: string;
  stopLoss: z.infer<typeof stopLossSettings>; historyItems: number; inputBytes: number;
  /** The start threshold L in credits (startThresholdCredits): the turn opens when the balance covers it, the freeze is
   *  H = min(G_turn, A), and a call pauses only below min(G_i, L) (Owner 10-01, restated 10-28; migration 0422). */
  startThresholdCredits: number;
  /** The model's nominal price table at open: a receipt the recovery job finds later is priced with it (V2-8), as a live one is. */
  pricing?: NominalPricing;
  /** Hashes and versions frozen for the golden-bytes test and the voice tombstone; never user text. */
  frozen?: Record<string, string | number | boolean>;
};

const validThreshold = (credits: number) => {
  if (!Number.isSafeInteger(credits) || credits < 1) throw new Error('TURN_POLICY_INVALID');
  return credits;
};

export function turnPolicy(input: PolicyInput) {
  const limits = turnLimits.parse(input.limits), stopLoss = stopLossSettings.parse(input.stopLoss);
  const paid = input.paidToolUpperUsd ?? [], other = input.otherModelCalls ?? [];
  if (paid.length !== (limits.toolRows ?? limits.paidTools)
    || limits.model + (limits.replayedModels ?? 0) !== 1 + limits.paidTools + limits.freeTools + other.length
    || (limits.decisions > 0) !== (input.decisionUpperUsd !== undefined)) throw new Error('TURN_POLICY_INVALID');
  const uModelCredits = callCredits(input.q, input.modelUpperUsd, input.multiplier);
  const own = limits.model - other.length;
  const gCredits = own * uModelCredits + paid.reduce((sum, u) => sum + callCredits(input.q, u, input.multiplier), 0)
    + other.reduce((sum, c) => sum + callCredits(input.q, c.upperUsd, c.multiplier), 0);
  const uTurn = units(input.modelUpperUsd) * BigInt(own) + [...paid, ...other.map(c => c.upperUsd)].reduce((sum, u) => sum + units(u), 0n)
    + (input.decisionUpperUsd === undefined ? 0n : units(input.decisionUpperUsd) * BigInt(limits.decisions));
  return {
    ...input.frozen,
    q: Number(input.q), multiplier: input.multiplier, modelUpperUsd: input.modelUpperUsd,
    ...(input.decisionUpperUsd === undefined ? {} : { decisionUpperUsd: input.decisionUpperUsd }),
    ...(input.pricing ? { pricing: input.pricing } : {}),
    uTurnUsd: Number(format(uTurn)), gCredits, uModelCredits,
    // The start threshold L (BILL-PAYG): what the balance must cover to start; below it mid-turn the turn pauses.
    minCredits: validThreshold(input.startThresholdCredits),
    limits, stopLoss, historyItems: input.historyItems, inputBytes: input.inputBytes,
  };
}
export type TurnPolicy = ReturnType<typeof turnPolicy>;

/**
 * BILL-PAYG start threshold L for one model and purpose, as bill2_payg_claim computes it from billing_payg_start_thresholds:
 * max(1, ceil(typicalUsd x q x m)), or a legacy entry's integer credits. Missing, duplicated or invalid: undefined, and the turn
 * is refused (never a guessed threshold).
 */
export function startThresholdCredits(setting: unknown, model: string, purpose: string, q: string, multiplier: string): number | undefined {
  const parsed = z.object({ version: z.string().trim().min(1), thresholds: z.array(z.record(z.string(), z.unknown())) })
    .passthrough().safeParse(setting);
  if (!parsed.success) return undefined;
  const matches = parsed.data.thresholds.filter(entry => entry.model === model && entry.purpose === purpose);
  if (matches.length !== 1) return undefined;
  const entry = matches[0]!;
  if ('typicalUsd' in entry) {
    if ('credits' in entry || !decimal.safeParse(entry.typicalUsd).success) return undefined;
    const credits = Math.max(1, callCredits(q, entry.typicalUsd as string, multiplier));
    return credits <= 2147483647 ? credits : undefined;
  }
  const credits = entry.credits;
  return typeof credits === 'number' && Number.isSafeInteger(credits) && credits >= 1 && credits <= 999999999 ? credits
    : typeof credits === 'string' && /^[1-9][0-9]{0,8}$/.test(credits) ? Number(credits) : undefined;
}
