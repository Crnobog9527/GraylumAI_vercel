/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ResearchRounds, ToolCallOutcome } from './types';

/*
 * CORE-PATH-V2 4.3 (Owner 10-20 fallback B, 10-27): the benchmark research rounds a turn completed. A keyword discovery round
 * that returned data counts once; a pasted-link check counts once when it completed (failed, refused or unknown checks do not
 * count, and the same check is never counted twice). The mentor kind writes the counts with turn_close (opc_drafts, V2-5) and
 * the next turn_open returns them; `fallbackEligible` is what the opened event carries.
 */
export function researchRounds() {
  const checks = new Set<string>();
  let keywordSearches = 0;
  const counted = (outcome: ToolCallOutcome) => outcome === 'delivered';
  return {
    /** One discovery round (keyword search across the confirmed platforms). */
    discovery(outcome: ToolCallOutcome) { if (counted(outcome)) keywordSearches++; },
    /** One pasted-link check, identified by its stable id (the user message and accounts it checked). */
    linkCheck(checkId: string, outcome: ToolCallOutcome) { if (counted(outcome)) checks.add(checkId); },
    value(): ResearchRounds { return { keywordSearches, linkChecks: checks.size }; },
  };
}

/** Fallback B (Owner 10-20): at least one qualified benchmark and at least two confirmed search rounds (links count, 10-27). */
export const FALLBACK_MIN_QUALIFIED = 1;
export const FALLBACK_MIN_ROUNDS = 2;
export function fallbackEligible(input: { qualified: number; rounds: ResearchRounds }): boolean {
  return input.qualified >= FALLBACK_MIN_QUALIFIED && input.rounds.keywordSearches + input.rounds.linkChecks >= FALLBACK_MIN_ROUNDS;
}
