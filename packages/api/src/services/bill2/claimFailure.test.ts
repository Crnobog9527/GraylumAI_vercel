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
  expect(log).toHaveBeenCalledExactlyOnceWith('api', 'Billing claim rejected',
    { code: 'BILL2_START_THRESHOLD_UNCONFIGURED' });
});
it.each([null, 'PRIVATE_INPUT', { message: 'BILL2_PAYG_QUOTE_INVALID: PRIVATE_INPUT' },
  { message: 'PRIVATE_INPUT', code: 'PRIVATE_ACTOR' }, { code: 'lost' }])(
  'keeps unknown or ambiguous errors opaque: %j', value => {
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(claimFailure(value)).not.toBeInstanceOf(BillingClaimRejection);
    expect(log).toHaveBeenCalledExactlyOnceWith('api', 'Billing claim rejected',
      { code: 'BILL2_DATABASE_UNAVAILABLE' });
  });
it.each([
  [{ message: 'deadlock detected PRIVATE_INPUT', code: '40P01', details: 'PRIVATE_ACTOR' }, 'bill2_claim',
    { rpc: 'bill2_claim', databaseCode: '40P01' }],
  [{ message: 'Timed out acquiring connection from connection pool.', code: 'PGRST003' }, 'bill2_dispatch',
    { rpc: 'bill2_dispatch', databaseCode: 'PGRST003' }],
  [{ message: 'TimeoutError: The operation was aborted due to timeout', code: '', details: 'PRIVATE_INPUT' }, 'bill2_claim',
    { rpc: 'bill2_claim', clientTimeout: true }],
  [{ message: 'AbortError: This operation was aborted', code: '' }, undefined, { clientTimeout: true }],
  [{ message: 'PRIVATE_INPUT', code: '40P01; PRIVATE' }, 'bill2_claim', { rpc: 'bill2_claim' }],
])('logs only the RPC and a diagnostic class for an opaque failure: %j', (value, rpc, extra) => {
  const log = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const error = claimFailure(value, rpc);
  expect(error).not.toBeInstanceOf(BillingClaimRejection);
  expect(error.message).toBe('BILL2_DATABASE_UNAVAILABLE');
  expect(log).toHaveBeenCalledExactlyOnceWith('api', 'Billing claim rejected',
    { code: 'BILL2_DATABASE_UNAVAILABLE', ...extra });
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
});
it('does not add diagnostics to a known claim rejection', () => {
  const log = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  expect(claimFailure({ message: 'BILL2_CALL_PENDING', code: 'P0001' }, 'bill2_claim')).toBeInstanceOf(BillingClaimRejection);
  expect(log).toHaveBeenCalledExactlyOnceWith('api', 'Billing claim rejected', { code: 'BILL2_CALL_PENDING' });
});
