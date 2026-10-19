/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-SHORTFALL (0318, Owner 2026-10-20 choice B). The positioning turn's tool slots are full (PAYG maxTools),
// so the choice card is not a tool of its own: when a benchmark search round ends without new candidates, or an
// account fetch finishes, the host asks SQL for the card (research_benchmark_shortfall_offer decides whether it is
// due) and the tool result tells the coach to present it. Free: no supplier request, no charge.
import { logger } from '../../../lib/logger';
import { stableResearchId, type ResearchToolContext } from './toolContext';

export interface ShortfallNotice { cardId: string; qualified: number; required: number; rounds: number; message: string }

/** Fixed host text for the coach; never model-written. */
export const SHORTFALL_MESSAGE = 'After at least two searches there are still fewer qualified benchmarks than the report needs. '
  + 'The host has shown the user a choice card: keep looking for benchmarks (recommended), or generate the report now with '
  + 'the current qualified benchmarks; that report will say the sample is short and its conclusions have limited reference '
  + 'value. Tell the user briefly and recommend keeping on searching; the user answers on the card. Do not estimate credits.';

/** The card to present now, or undefined (not due, already answered, or the read failed: the tool result stands). */
export async function shortfallNotice(ctx: ResearchToolContext): Promise<ShortfallNotice | undefined> {
  try {
    const card = await ctx.store.offerShortfall(stableResearchId(ctx.executionId, 'benchmark-shortfall'));
    if (!card || card.choice !== null) return undefined;
    return { cardId: card.cardId, qualified: card.offeredQualified, required: card.required, rounds: card.offeredRounds,
      message: SHORTFALL_MESSAGE };
  } catch (error) {
    logger.warn('api', 'Benchmark shortfall card unavailable', { error: error instanceof Error ? error.message : 'unknown' });
    return undefined;
  }
}
