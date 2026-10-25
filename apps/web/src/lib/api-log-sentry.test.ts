/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '@sentry/nextjs';

const captured = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock('@sentry/nextjs', () => ({ captureMessage: (message: string, options: unknown) => { captured.push([message, options]); } }));
import { setLogSink } from '@repo/api/src/lib/logger';
import { logSwallowed } from '@repo/api/src/lib/swallow';
import { apiLogCode, connectApiLogsToSentry } from './api-log-sentry';
import { scrubErrorEvent } from './sentry-scrub';

afterEach(() => { setLogSink(null); captured.length = 0; });

describe('api logs reach Sentry as fixed codes only (MAINT-P3)', () => {
  it('a swallowed failure becomes one API_ code at warning level, with no context', () => {
    connectApiLogsToSentry();
    logSwallowed('fusion_compare_settle_failed', new Error('BILL2_X'), { category: 'billing', compareId: 'c-1', userId: 'u-1' });
    expect(captured).toEqual([['API_BILLING_FUSION_COMPARE_SETTLE_FAILED', { level: 'warning' }]]);
  });
  it('the code survives the scrubber; anything else in the message does not', () => {
    const code = apiLogCode({ level: 'error', category: 'billing', message: 'x'.repeat(200) });
    expect(code.length).toBeLessThanOrEqual(64);
    for (const message of [code, 'API_BILLING_FUSION_COMPARE_SETTLE_FAILED']) {
      expect(scrubErrorEvent({ message } as ErrorEvent).message).toBe(message);
    }
    expect(apiLogCode({ level: 'warn', category: 'system', message: 'a b-c' })).toBe('API_SYSTEM_A_B_C');
  });
});
