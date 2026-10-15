/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { claimOutcome } from './reviewLimits';

describe('claim outcome', () => {
  it('ends the step on any coded refusal; retries only listed transient failures and uncoded errors', () => {
    expect(claimOutcome(new Error('FUSION_INPUT_TOO_LARGE'))).toEqual({ kind: 'input_too_large' });
    expect(claimOutcome(new Error('FUSION_ESTIMATE_EXCEEDED'))).toEqual({ kind: 'price_changed' });
    for (const code of ['FUSION_REVIEW_SKILL_UNAVAILABLE', 'RUNTIME_STAGING_POLICY_DENIED', 'FUSION_REVIEW_DISABLED', 'SOME_NEW_REFUSAL'])
      expect(claimOutcome(new Error(code))).toEqual({ kind: 'claim_refused', reason: code });
    for (const code of ['RUNTIME_STAGING_SERVICE_UNAVAILABLE', 'FUSION_ADMISSION_UNAVAILABLE', 'RUNTIME_PRICE_SNAPSHOT_STALE',
      'RUNTIME_PRICE_CONFIGURATION_PENDING', 'fetch failed', ''])
      expect(claimOutcome(new Error(code))).toBeNull();
    expect(claimOutcome('not an error')).toBeNull();
  });
});
