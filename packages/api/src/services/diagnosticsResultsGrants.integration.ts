/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// S1-FIX batch 3: real diagnostics result writes/reads -> supabase-js -> local PostgREST with 0146.
import { it, expect } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DiagnosticsService, type DiagnosticTestResult } from './diagnostics';
import {
  deleteOldDiagnosticResults,
  readDiagnosticSummary,
  readDiagnosticTestHistory,
  readLatestDiagnosticResults,
} from './diagnosticsResults';

const origin = process.env.S1F3_LOCAL_REST!;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')) throw new Error('S1-FIX-3 isolated runner required');
const nativeFetch = globalThis.fetch;
const localFetch: typeof fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== origin) throw new Error('Non-local request forbidden');
  target.pathname = target.pathname.replace(/^\/rest\/v1/, '');
  return nativeFetch(target, init);
};
const client = (key: string) => createClient(origin, key, {
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: localFetch },
});
const RESULT: DiagnosticTestResult = {
  testId: 'ai_routing', testName: 'AI routing', category: 'ai', status: 'warning',
  message: 'synthetic integration', latencyMs: 12,
};
type Saver = { saveResults(batchId: string, results: DiagnosticTestResult[]): Promise<{ saved: boolean }> };
const saver = (supabase: SupabaseClient, supabaseAdmin: SupabaseClient) =>
  new DiagnosticsService({ supabase, supabaseAdmin, userId: process.env.S1F3_ADMIN_ID! }) as unknown as Saver;

it('S1-FIX-3: the admin diagnostics page saves and reads results through service_role', async () => {
  const service = client(process.env.S1F3_SERVICE_JWT!);
  const admin = client(process.env.S1F3_ADMIN_JWT!);
  // The admin's own JWT client is passed as `supabase`; saving must not depend on it.
  await expect(saver(admin, service).saveResults(crypto.randomUUID(), [RESULT])).resolves.toEqual({ saved: true });
  const latest = await readLatestDiagnosticResults(service, ['ai_routing']);
  expect(latest).toEqual([expect.objectContaining({ test_id: 'ai_routing', status: 'warning' })]);
  expect((await readDiagnosticTestHistory(service, 'ai_routing', 10)).length).toBe(3);
  expect(await readDiagnosticSummary(service, 24)).toMatchObject({ total_tests: 2, passed_tests: 1, warning_tests: 1 });
  expect(await deleteOldDiagnosticResults(service, 30)).toBe(1);
});

it('S1-FIX-3: admin, user and anonymous JWTs cannot read or write diagnostic results', async () => {
  for (const token of [process.env.S1F3_ADMIN_JWT!, process.env.S1F3_OWNER_JWT!, process.env.S1F3_ANON_JWT!]) {
    const caller = client(token);
    await expect(saver(caller, caller).saveResults(crypto.randomUUID(), [RESULT])).resolves.toMatchObject({ saved: false });
    await expect(readLatestDiagnosticResults(caller, ['ai_routing'])).rejects.toThrow('(42501)');
    await expect(deleteOldDiagnosticResults(caller, 0)).rejects.toThrow('(42501)');
  }
});
