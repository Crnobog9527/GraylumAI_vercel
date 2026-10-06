/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '../../lib/logger';
import { BillingClaimRejection, claimFailure } from './claimFailure';
afterEach(() => vi.restoreAllMocks());
it('retains a known claim rejection without logging database details or identifiers', () => {
  const log = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const error = claimFailure({ message: 'BILL2_START_THRESHOLD_UNCONFIGURED',
    details: 'PRIVATE_INPUT', hint: 'PRIVATE_ACTOR', code: 'P0001' });
  expect(error).toBeInstanceOf(BillingClaimRejection);
  expect(error.message).toBe('BILL2_START_THRESHOLD_UNCONFIGURED');
  expect(log).toHaveBeenCalledExactlyOnceWith('api', 'bill2_claim_rejected',
    { code: 'BILL2_START_THRESHOLD_UNCONFIGURED' });
});
it.each([null, 'PRIVATE_INPUT', { message: 'BILL2_PAYG_QUOTE_INVALID: PRIVATE_INPUT' },
  { message: 'PRIVATE_INPUT', code: 'PRIVATE_ACTOR' }, { code: 'lost' }])(
  'keeps unknown or ambiguous errors opaque: %j', value => {
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(claimFailure(value)).not.toBeInstanceOf(BillingClaimRejection);
    expect(log).toHaveBeenCalledExactlyOnceWith('api', 'bill2_claim_rejected',
      { code: 'BILL2_DATABASE_UNAVAILABLE' });
  });
