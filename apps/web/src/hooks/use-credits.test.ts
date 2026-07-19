import { describe, expect, it } from 'vitest';
import { deriveCreditsBalanceState } from './use-credits';

describe('deriveCreditsBalanceState', () => {
  it('keeps initial loading distinct from zero', () => {
    expect(deriveCreditsBalanceState({ isLoading: true })).toEqual({
      status: 'loading',
      credits: null,
      creditsExpiringSoon: null,
      creditsExpiryDate: null,
      warningLevel: null,
    });
  });

  it('treats a real zero as ready with an empty warning', () => {
    expect(deriveCreditsBalanceState({ data: { credits: 0 } })).toMatchObject({
      status: 'ready',
      credits: 0,
      warningLevel: 'empty',
    });
  });

  it('treats a positive balance as ready', () => {
    expect(deriveCreditsBalanceState({ data: { credits: 250 } })).toMatchObject({
      status: 'ready',
      credits: 250,
      warningLevel: 'none',
    });
  });

  it('makes a failed refetch unavailable even when stale positive data remains', () => {
    expect(deriveCreditsBalanceState({
      data: { credits: 500 },
      error: new Error('network unavailable'),
    })).toEqual({
      status: 'unavailable',
      credits: null,
      creditsExpiringSoon: null,
      creditsExpiryDate: null,
      warningLevel: null,
    });
  });

  it.each([null, undefined, '0', Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'does not turn invalid balance %s into a ready zero',
    (credits) => {
      expect(deriveCreditsBalanceState({ data: { credits } })).toMatchObject({
        status: 'unavailable',
        credits: null,
        warningLevel: null,
      });
    },
  );
});
