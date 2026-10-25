/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it } from 'vitest';
import { logger, setLogSink, type LogSink } from './logger';
import { errorCode, logSwallowed, swallow } from './swallow';

const seen: Array<Parameters<LogSink>[0]> = [];
afterEach(() => { setLogSink(null); seen.length = 0; });

describe('swallow (MAINT-P3)', () => {
  it('returns the value, or the fallback with the failure logged to the sink', async () => {
    setLogSink(entry => { seen.push(entry); });
    expect(await swallow('a_label', Promise.resolve(7), null)).toBe(7);
    expect(seen).toEqual([]);
    expect(await swallow('fusion_compare_settle_failed', Promise.reject(new Error('BILL2_DB')), 'fallback', { category: 'billing' }))
      .toBe('fallback');
    expect(seen).toEqual([{ level: 'warn', category: 'billing', message: 'fusion_compare_settle_failed' }]);
  });
  it('forwards only swallowed warnings and errors, never other warnings, and never the context', () => {
    setLogSink(entry => { seen.push(entry); });
    logSwallowed('x_failed', new Error('nope'), { userId: 'u-1' });
    logger.warn('auth', 'plain_warning', { userId: 'u-1' });
    logger.error('billing', 'hard_failure', { userId: 'u-1' });
    expect(seen).toEqual([{ level: 'warn', category: 'system', message: 'x_failed' },
      { level: 'error', category: 'billing', message: 'hard_failure' }]);
  });
  it('a failing sink never reaches the caller', async () => {
    setLogSink(() => { throw new Error('sentry down'); });
    expect(await swallow('x_failed', Promise.reject(new Error('X')), 1)).toBe(1);
  });
  it('keeps only stable codes, never free text', () => {
    expect(errorCode(new Error('FUSION_DATABASE_UNAVAILABLE'))).toBe('FUSION_DATABASE_UNAVAILABLE');
    expect(errorCode(new Error('duplicate key for user@example.com'))).toBe('Error');
    expect(errorCode(new TypeError('x is undefined'))).toBe('TypeError');
    expect(errorCode('PAY_X_FAILED')).toBe('PAY_X_FAILED');
    expect(errorCode({ message: 'secret' })).toBe('unknown');
  });
});
