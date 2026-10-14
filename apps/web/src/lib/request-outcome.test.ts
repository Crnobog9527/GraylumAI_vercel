/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { outcomeUnknown } from './request-outcome';

const answered = (code: string) => Object.assign(new Error(code), { data: { code, httpStatus: 409 } });

describe('outcomeUnknown', () => {
  it('is unknown without a server answer: reload, network drop, gateway timeout', () => {
    expect(outcomeUnknown(new TypeError('Failed to fetch'))).toBe(true);
    expect(outcomeUnknown(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(outcomeUnknown(null)).toBe(true);
  });

  it('is unknown when the server failed unexpectedly', () => {
    expect(outcomeUnknown(answered('INTERNAL_SERVER_ERROR'))).toBe(true);
    expect(outcomeUnknown(answered('TIMEOUT'))).toBe(true);
  });

  it('is known for a bounded application refusal even under a generic code (OPC routers)', () => {
    expect(outcomeUnknown(Object.assign(new Error('OPC_CONVERSATION_ERASED'), { data: { code: 'INTERNAL_SERVER_ERROR' } }))).toBe(false);
    expect(outcomeUnknown(Object.assign(new Error('Something broke'), { data: { code: 'INTERNAL_SERVER_ERROR' } }))).toBe(true);
  });

  it('is known when the server refused with an application code', () => {
    for (const code of ['CONFLICT', 'NOT_FOUND', 'TOO_MANY_REQUESTS', 'SERVICE_UNAVAILABLE', 'UNAUTHORIZED', 'BAD_REQUEST']) {
      expect(outcomeUnknown(answered(code))).toBe(false);
    }
  });
});
