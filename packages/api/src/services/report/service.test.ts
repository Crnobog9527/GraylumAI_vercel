/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reportEnabled, reportError } from './service';

// The report switch and the report error boundary. Starting, pricing and reading a report run on the turn path
// (turn/report.test.ts, turn/reportHttp.test.ts); the old report admission tests that lived here went with it.
it.each([[{ enabled: true }, true], [null, false], [{ enabled: false }, false], ['{"enabled":true}', false], [{ enabled: true, extra: 1 }, false],
  [{ enabled: 'true' }, false], ['invalid', false]])(
  'reportEnabled reads a strict switch: only {enabled:true} opens a new report (%j)', async (value, expected) => {
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: value === null ? null : { value }, error: null }) };
    expect(await reportEnabled({ from: () => query } as unknown as SupabaseClient)).toBe(expected);
  });
it('reportEnabled fails closed on a read error', async () => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: { message: 'x' } }) };
  await expect(reportEnabled({ from: () => query } as unknown as SupabaseClient)).rejects.toThrow('REPORT_UNAVAILABLE');
});
it.each(['OPC_CAPTURE_PENDING', 'REPORT_BENCHMARKS_REQUIRED', 'REPORT_PRICE_CHANGED'])('SQL %s survives the report error boundary', code => {
  expect(() => reportError({ code: 'P0001', message: code })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST', message: code }));
});
it('a membership refusal is forbidden, and anything unlisted is an opaque REPORT_UNAVAILABLE', () => {
  expect(() => reportError(new Error('REPORT_MEMBERSHIP_REQUIRED'))).toThrow(expect.objectContaining({ code: 'FORBIDDEN', message: 'REPORT_MEMBERSHIP_REQUIRED' }));
  expect(() => reportError({ message: 'SYNTHETIC_PRIVATE_DETAIL' })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST', message: 'REPORT_UNAVAILABLE' }));
});
