/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Diagnostics history read straight from diagnostic_results. The 0005 view
// diagnostic_latest_results and RPCs get_diagnostic_summary / get_test_history /
// cleanup_old_diagnostic_results do not exist on staging; these keep their semantics without them.
import type { SupabaseClient } from '@supabase/supabase-js';

// PostgREST caps a response at 1000 rows; the summary pages through the window up to this bound.
const PAGE_SIZE = 1000;
const MAX_SUMMARY_PAGES = 50;
const RESULT_COLUMNS = 'test_id, test_name, category, status, message, details, latency_ms, created_at';

type ResultRow = {
  test_id: string;
  test_name: string;
  category: string;
  status: string;
  message: string | null;
  details: Record<string, unknown> | undefined;
  latency_ms: number | null;
  created_at: string;
};

function fail(operation: string, error: { code?: string } | null): never {
  throw new Error(`diagnostic_results ${operation} failed${error?.code ? ` (${error.code})` : ''}`);
}

/**
 * Newest row of each defined test, newest first (the old diagnostic_latest_results view, limited to
 * tests the page defines; retired test ids are no longer listed). One bounded query per test, so a
 * frequently re-run test can never hide another test's latest result.
 */
export async function readLatestDiagnosticResults(client: SupabaseClient, testIds: readonly string[]) {
  const rows = await Promise.all(testIds.map(async (testId) => {
    const { data, error } = await client.from('diagnostic_results').select(RESULT_COLUMNS)
      .eq('test_id', testId).order('created_at', { ascending: false }).limit(1);
    if (error) fail('latest read', error);
    return ((data ?? []) as ResultRow[])[0] ?? null;
  }));
  return rows.filter((row): row is ResultRow => row !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Newest results of one test (the old get_test_history RPC). */
export async function readDiagnosticTestHistory(client: SupabaseClient, testId: string, limit: number) {
  const { data, error } = await client.from('diagnostic_results')
    .select('id, status, message, latency_ms, created_at')
    .eq('test_id', testId).order('created_at', { ascending: false }).limit(limit);
  if (error) fail('history read', error);
  return (data ?? []) as Array<{ id: string; status: string; message: string | null;
    latency_ms: number | null; created_at: string }>;
}

/**
 * Window statistics (the old get_diagnostic_summary RPC). Every field comes from one paged read of
 * the whole window, so counts, pass rate and latency are always mutually consistent. Paging runs
 * oldest-first so rows written meanwhile land after the pages already read; a window larger than the
 * page bound fails instead of returning partial statistics.
 */
export async function readDiagnosticSummary(client: SupabaseClient, hours: number) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows: Array<{ status: string; latency_ms: number | null; created_at: string }> = [];
  for (let page = 0; ; page += 1) {
    if (page === MAX_SUMMARY_PAGES) fail('summary window too large', null);
    const { data, error } = await client.from('diagnostic_results').select('status, latency_ms, created_at')
      .gte('created_at', since).order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) fail('summary read', error);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  const byStatus = (status: string) => rows.filter(row => row.status === status).length;
  const latencies = rows.map(row => row.latency_ms).filter((value): value is number => value !== null);
  const round2 = (value: number) => Math.round(value * 100) / 100;
  const total = rows.length;
  const passed = byStatus('passed');
  return {
    total_tests: total,
    passed_tests: passed,
    failed_tests: byStatus('failed'),
    warning_tests: byStatus('warning'),
    pass_rate: total > 0 ? round2((passed / total) * 100) : 0,
    avg_latency_ms: latencies.length > 0 ? round2(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    last_run: rows.at(-1)?.created_at ?? null,
  };
}

/** Deletes results older than daysToKeep (the old cleanup_old_diagnostic_results RPC). */
export async function deleteOldDiagnosticResults(client: SupabaseClient, daysToKeep: number) {
  const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await client.from('diagnostic_results')
    .delete({ count: 'exact' }).lt('created_at', cutoff);
  if (error) fail('cleanup', error);
  return count ?? 0;
}
