/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { assertCompareFits, compareRequest, type CompareParts } from '../fusion/compareSnapshot';
import { decimal, DECIMAL_SCALE } from '../bill2/decimal';
import { fusionRequestBody } from '../fusion/request';
import { TurnStop, type ModelCall } from './call';
import { fusionCall, type FusionQuote } from './fusionQuote';
import { callCredits } from './policy';

/*
 * CORE-PATH-V2 V2-7b: what a compare on the turn path may cost, the one computation behind the estimate the user agrees to and
 * the freeze of the turn, so the two cannot differ: every column's exact request with the fallback rule (the larger of the two
 * possible requests), its bound in USD and in credits, rounded per column. A model that cannot take the request whole is listed
 * in tooLarge and never shortened (buildCompareColumns' rule).
 */
export type PricedColumn = { index: number; modelId: string; call: ModelCall; upperCredits: number; upperUsd: string };

export function priceCompareColumns(input: { quotes: FusionQuote[]; parts: CompareParts; answerTokens: number; maxBudgetUsd: string | null }) {
  const { quotes, parts } = input;
  const request = compareRequest({ ...parts, positioningFallback: true });
  assertCompareFits(request);
  const q = quotes[0]!.q;
  const columns: PricedColumn[] = [], tooLarge: string[] = [];
  quotes.forEach((quote, index) => {
    try {
      if (quote.outputLimit !== input.answerTokens) throw new TurnStop('TURN_INPUT_TOO_LARGE');
      const call = fusionCall(quote, fusionRequestBody(quote.policy as never, request, quote.outputLimit, quote.reasoning));
      columns.push({ index, modelId: quote.modelId, call, upperCredits: callCredits(q, call.upperUsd, call.multiplier), upperUsd: call.upperUsd });
    } catch (error) {
      if (!(error instanceof TurnStop) || error.code !== 'TURN_INPUT_TOO_LARGE') throw error;
      tooLarge.push(quote.modelId);
    }
  });
  const credits = columns.reduce((sum, column) => sum + column.upperCredits, 0);
  const usd = columns.reduce((sum, column) => sum + decimal(column.upperUsd), 0n);
  // The single-compare budget (Owner 10-26) holds both ways, as overCompareBudget: the columns' provider cost bounds, and what
  // the user may pay (each column rounded on its own) against the budget converted at q.
  const overBudget = !input.maxBudgetUsd || usd > decimal(input.maxBudgetUsd)
    || BigInt(credits) > decimal(input.maxBudgetUsd) * decimal(q) / (DECIMAL_SCALE * DECIMAL_SCALE);
  return { q, columns, tooLarge, credits, overBudget };
}
