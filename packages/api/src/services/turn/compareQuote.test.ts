import { describe, expect, it, vi } from 'vitest';
import { TurnStop } from './call';

/* CORE-PATH-V2 V2-7b: the one computation behind a compare's estimate and its freeze (turn/compareQuote.ts). */
const m = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../fusion/compareSnapshot', () => ({ compareRequest: (parts: object) => ({ parts }), assertCompareFits: () => {} }));
vi.mock('../fusion/request', () => ({ fusionRequestBody: () => '{}' }));
vi.mock('./fusionQuote', () => ({ fusionCall: m.call }));
import { priceCompareColumns } from './compareQuote';

const quote = (modelId: string, outputLimit = 100) => ({ modelId, q: '100', outputLimit, policy: {}, reasoning: {} }) as never;
const parts = { question: 'q' } as never;
// A column's bound: upperUsd 0.01 at q=100 and m=6 is ceil(100 x 0.01 x 6) = 6 credits.
const call = (upperUsd: string) => ({ upperUsd, multiplier: '6' });

describe('compare columns priced', () => {
  it('rounds every column on its own and sums them, in the user\'s order', () => {
    m.call.mockReturnValueOnce(call('0.01')).mockReturnValueOnce(call('0.0011'));
    const priced = priceCompareColumns({ quotes: [quote('a'), quote('b')], parts, answerTokens: 100, maxBudgetUsd: '5' });
    expect(priced.columns.map(c => [c.index, c.modelId, c.upperCredits])).toEqual([[0, 'a', 6], [1, 'b', 1]]);
    expect(priced).toMatchObject({ credits: 7, tooLarge: [], overBudget: false });
  });

  it('a model that cannot take the request whole is listed and never shortened', () => {
    m.call.mockReturnValueOnce(call('0.01')).mockImplementationOnce(() => { throw new TurnStop('TURN_INPUT_TOO_LARGE'); });
    const priced = priceCompareColumns({ quotes: [quote('a'), quote('b')], parts, answerTokens: 100, maxBudgetUsd: '5' });
    expect(priced.tooLarge).toEqual(['b']);
    expect(priced.columns.map(c => c.modelId)).toEqual(['a']);
    // An answer limit other than the frozen one is the same refusal (every column keeps the one limit).
    m.call.mockReturnValueOnce(call('0.01'));
    expect(priceCompareColumns({ quotes: [quote('a', 50)], parts, answerTokens: 100, maxBudgetUsd: '5' }).tooLarge).toEqual(['a']);
  });

  it('is over budget on the provider cost or on what the user may pay; no budget is never unlimited', () => {
    m.call.mockReturnValue(call('0.01'));
    const priced = (maxBudgetUsd: string | null) => priceCompareColumns({ quotes: [quote('a'), quote('b')], parts, answerTokens: 100, maxBudgetUsd });
    expect(priced('5').overBudget).toBe(false);
    expect(priced('0.019').overBudget).toBe(true);
    // 12 credits against a 0.1 USD budget at q=100 (10 credits) while the provider cost 0.02 is within it.
    expect(priced('0.1').overBudget).toBe(true);
    expect(priced(null).overBudget).toBe(true);
  });

  it('passes any other failure on', () => {
    m.call.mockImplementationOnce(() => { throw new TurnStop('TURN_PAUSED_FOR_CREDITS'); });
    expect(() => priceCompareColumns({ quotes: [quote('a')], parts, answerTokens: 100, maxBudgetUsd: '5' })).toThrow();
  });
});
