/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/*
 * CORE-PATH-V2 2.5 / 2.5.3: the numbers a turn freezes at turn_open, computed from the catalog cache (q, the model multiplier m,
 * the call bound U, the call limits, the stop-loss parameters). One model call costs the user at most G = ceil(q x U x m) credits;
 * every tool return makes the model run once more, so M = 1 + paid tools + free tools model calls. G_turn = M x G_model + sum of
 * the paid tools' G, and U_turn (USD, the stop-loss reservation) is the same sum without q and m. Exact decimals, no floats.
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
  freeTools: z.number().int().min(0).max(8), decisions: z.number().int().min(0).max(1) }).strict()
  .refine(l => l.model === 1 + l.paidTools + l.freeTools + l.decisions,
    'every tool return is one more model call (2.5.3); a Decisions check is one more call row');
export type TurnLimits = z.infer<typeof turnLimits>;
export const stopLossSettings = z.object({ limitUsd: z.number().positive(), p: z.number().int().min(1),
  poolSize: z.number().int().min(1), uFastUsd: z.number().nonnegative(), uBigUsd: z.number().nonnegative() }).strict();

export type PolicyInput = {
  q: string; multiplier: string; modelUpperUsd: string; limits: TurnLimits;
  /** One bound per allowed paid tool call (research), in USD; the tool's own multiplier is the model's here. */
  paidToolUpperUsd?: readonly string[];
  stopLoss: z.infer<typeof stopLossSettings>; historyItems: number; inputBytes: number;
  /** Hashes and versions frozen for the golden-bytes test and the voice tombstone; never user text. */
  frozen?: Record<string, string | number | boolean>;
};

export function turnPolicy(input: PolicyInput) {
  const limits = turnLimits.parse(input.limits), stopLoss = stopLossSettings.parse(input.stopLoss);
  const paid = input.paidToolUpperUsd ?? [];
  if (paid.length !== limits.paidTools) throw new Error('TURN_POLICY_INVALID');
  // The Decisions check (positioning gate) is a call row that costs the user nothing: it is in M, not in G or U.
  const paidModelCalls = limits.model - limits.decisions;
  const uModelCredits = callCredits(input.q, input.modelUpperUsd, input.multiplier);
  const gCredits = paidModelCalls * uModelCredits + paid.reduce((sum, u) => sum + callCredits(input.q, u, input.multiplier), 0);
  const uTurn = units(input.modelUpperUsd) * BigInt(paidModelCalls) + paid.reduce((sum, u) => sum + units(u), 0n);
  return {
    ...input.frozen,
    q: Number(input.q), multiplier: input.multiplier, modelUpperUsd: input.modelUpperUsd,
    uTurnUsd: Number(format(uTurn)), gCredits, uModelCredits,
    // The start threshold: one model call (BILL-PAYG L); a short freeze pauses the turn before a call it cannot cover.
    minCredits: uModelCredits,
    limits, stopLoss, historyItems: input.historyItems, inputBytes: input.inputBytes,
  };
}
export type TurnPolicy = ReturnType<typeof turnPolicy>;
