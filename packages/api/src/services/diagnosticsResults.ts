/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Diagnostics history read straight from diagnostic_results. The 0005 view
// diagnostic_latest_results and RPCs get_diagnostic_summary / get_test_history /
// cleanup_old_diagnostic_results do not exist on staging; these keep their semantics without them.
import type { SupabaseClient } from '@supabase/supabase-js';

// Runs write ~20 rows, so the newest window comfortably covers every test id.
const LATEST_WINDOW = 1000;
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

/** Newest row per test_id, newest first (the old diagnostic_latest_results view). */
export async function readLatestDiagnosticResults(client: SupabaseClient) {
  const { data, error } = await client.from('diagnostic_results').select(RESULT_COLUMNS)
    .order('created_at', { ascending: false }).limit(LATEST_WINDOW);
  if (error) fail('latest read', error);
  const latest = new Map<string, ResultRow>();
  for (const row of (data ?? []) as ResultRow[]) {
    if (!latest.has(row.test_id)) latest.set(row.test_id, row);
  }
  return [...latest.values()];
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

/** Window statistics (the old get_diagnostic_summary RPC): exact counts, latency from the newest rows. */
export async function readDiagnosticSummary(client: SupabaseClient, hours: number) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const count = async (status?: string) => {
    let query = client.from('diagnostic_results').select('id', { count: 'exact', head: true })
      .gte('created_at', since);
    if (status) query = query.eq('status', status);
    const { count: value, error } = await query;
    if (error) fail('summary count', error);
    return value ?? 0;
  };
  const [total, passed, failed, warning, recent] = await Promise.all([
    count(), count('passed'), count('failed'), count('warning'),
    client.from('diagnostic_results').select('latency_ms, created_at').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(LATEST_WINDOW),
  ]);
  if (recent.error) fail('summary latency read', recent.error);
  const rows = (recent.data ?? []) as Array<{ latency_ms: number | null; created_at: string }>;
  const latencies = rows.map(row => row.latency_ms).filter((value): value is number => value !== null);
  const round2 = (value: number) => Math.round(value * 100) / 100;
  return {
    total_tests: total,
    passed_tests: passed,
    failed_tests: failed,
    warning_tests: warning,
    pass_rate: total > 0 ? round2((passed / total) * 100) : 0,
    avg_latency_ms: latencies.length > 0 ? round2(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    last_run: rows[0]?.created_at ?? null,
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
