/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { decisionsClassifier, POSITIONING_REFUSAL_CAP, readPositioningGate, type GateVerdict, type PositioningClassifier,
  type PositioningGateState } from '../runtime/positioningGate';

/** POSITIONING-GATE for a compare (FUSION-COMPARE §3.2), the ordinary rules applied before any group exists:
 * a user who already has a confirmed positioning is never gated ('allow', no paid judgement); a Skill marked social-media
 * is refused outright for a user without one; otherwise Decisions judges the message once. */
export type CompareGate = { gated: boolean; capped: boolean; state: PositioningGateState };

export async function readCompareGate(admin: SupabaseClient, actorId: string): Promise<CompareGate> {
  const state = await readPositioningGate(admin, actorId);
  const gated = !state.positioned;
  return { gated, capped: gated && state.refusals24h >= POSITIONING_REFUSAL_CAP, state };
}

/** The free static part, for the estimate and again for the start: no paid call. Throws POSITIONING_REQUIRED-style
 * refusals through `refuse`; reports whether the refund cap is reached so the page can say so. */
export function staticCompareGate(gate: CompareGate, skill: { socialMedia: boolean } | null, refuse: () => never) {
  if (gate.gated && skill?.socialMedia) refuse();
  return { refundCapReached: gate.capped };
}

export type CompareGateOutcome = { verdict: GateVerdict; refused: boolean; fallback: boolean };

/** The paid judgement, called at most once per request id (the caller records the request first). Same decision table as
 * judgePositioning: block refuses; at the cap only 'clear' goes on, without the fallback rule; below the cap everything
 * else goes on with the fallback rule attached. An unusable classifier counts as 'unavailable'. */
export async function judgeCompareGate(gate: CompareGate, input: { text: string; apiKey: string | undefined },
  classify: PositioningClassifier = decisionsClassifier()): Promise<CompareGateOutcome> {
  if (!gate.gated) return { verdict: 'allow', refused: false, fallback: false };
  let verdict: GateVerdict;
  try { verdict = await classify(input); } catch { verdict = 'unavailable'; }
  if (verdict === 'block' || (gate.capped && verdict !== 'clear')) return { verdict: 'block', refused: true, fallback: false };
  return { verdict, refused: false, fallback: !gate.capped };
}
