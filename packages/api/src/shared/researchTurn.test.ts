/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { statusForOutcome } from '../services/research/tools/envelope';
import { SUPPLIER_UNAVAILABLE_REASON, supplierUnavailable } from './researchTurn';

describe('supplier unavailable (round 13: TikHub answered HTTP 402)', () => {
  it('payment required, refused key, rate limit and server errors are the supplier being unavailable', () => {
    for (const code of ['HTTP_401', 'HTTP_402', 'HTTP_403', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']) {
      expect(supplierUnavailable(code), code).toBe(true);
    }
  });
  it('an empty answer, a bad request, a missing page or no reason are not', () => {
    for (const code of ['HTTP_400', 'HTTP_404', 'HTTP_200', 'NO_RESULTS', 'RESULT_TRUNCATED', 'TIMEOUT', 'ROUND_LIMIT', '', null, undefined]) {
      expect(supplierUnavailable(code as string | null | undefined), String(code)).toBe(false);
    }
  });
  it('the model reads it as SUPPLIER_UNAVAILABLE, other failures stay PROVIDER_FAILED', () => {
    expect(statusForOutcome({ outcome: 'failed', reason: 'HTTP_402' })).toEqual({ status: 'unavailable', reason: SUPPLIER_UNAVAILABLE_REASON });
    expect(statusForOutcome({ outcome: 'failed', reason: 'HTTP_404' })).toEqual({ status: 'unavailable', reason: 'PROVIDER_FAILED' });
    expect(statusForOutcome({ outcome: 'failed', reason: null })).toEqual({ status: 'unavailable', reason: 'PROVIDER_FAILED' });
  });
});
