import { describe, expect, it } from 'vitest';
import { loadLatestRuntimeProof } from './diagnostics';
import {
  deleteOldDiagnosticResults,
  readDiagnosticSummary,
  readDiagnosticTestHistory,
  readLatestDiagnosticResults,
} from './diagnosticsResults';

// Minimal PostgREST stand-in: records filters, answers counts by status and rows for reads.
function client(options: { rows?: unknown[]; counts?: Record<string, number>; error?: { code: string } }) {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    from(table: string) {
      calls.push(['from', table]);
      const state: { head?: boolean; status?: string } = {};
      const builder: Record<string, unknown> = {};
      for (const method of ['order', 'limit', 'gte', 'lt']) {
        builder[method] = (...args: unknown[]) => { calls.push([method, ...args]); return builder; };
      }
      builder.select = (columns: string, opts?: { head?: boolean }) => {
        calls.push(['select', columns]);
        state.head = opts?.head;
        return builder;
      };
      builder.eq = (column: string, value: string) => {
        calls.push(['eq', column, value]);
        if (column === 'status') state.status = value;
        return builder;
      };
      builder.delete = (opts: unknown) => { calls.push(['delete', opts]); return builder; };
      builder.maybeSingle = () => Promise.resolve(options.error
        ? { data: null, error: options.error } : { data: null, error: null });
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(options.error
        ? { data: null, count: null, error: options.error }
        : state.head
          ? { count: options.counts?.[state.status ?? 'all'] ?? 0, error: null }
          : { data: options.rows ?? [], count: options.counts?.deleted ?? 0, error: null }).then(resolve);
      return builder;
    },
  } as any;
}

describe('diagnostics results without the 0005 view/RPCs', () => {
  it('keeps only the newest row of each test id', async () => {
    const rows = [
      { test_id: 'a', status: 'failed', created_at: '2026-09-29T10:00:00Z' },
      { test_id: 'b', status: 'passed', created_at: '2026-09-29T09:00:00Z' },
      { test_id: 'a', status: 'passed', created_at: '2026-09-29T08:00:00Z' },
    ];
    const db = client({ rows });

    const latest = await readLatestDiagnosticResults(db);

    expect(latest.map(row => [row.test_id, row.status])).toEqual([['a', 'failed'], ['b', 'passed']]);
    expect(db.calls).toContainEqual(['from', 'diagnostic_results']);
    expect(db.calls).toContainEqual(['order', 'created_at', { ascending: false }]);
  });

  it('computes summary counts, pass rate, average latency and last run', async () => {
    const db = client({
      counts: { all: 8, passed: 6, failed: 1, warning: 1 },
      rows: [{ latency_ms: 10, created_at: '2026-09-29T10:00:00Z' }, { latency_ms: 21, created_at: 't2' },
        { latency_ms: null, created_at: 't3' }],
    });

    await expect(readDiagnosticSummary(db, 24)).resolves.toEqual({
      total_tests: 8, passed_tests: 6, failed_tests: 1, warning_tests: 1,
      pass_rate: 75, avg_latency_ms: 15.5, last_run: '2026-09-29T10:00:00Z',
    });
  });

  it('returns a zero summary for an empty window', async () => {
    await expect(readDiagnosticSummary(client({}), 1)).resolves.toMatchObject({
      total_tests: 0, pass_rate: 0, avg_latency_ms: 0, last_run: null,
    });
  });

  it('reads one test history newest first with the limit', async () => {
    const db = client({ rows: [{ id: 'r1', status: 'passed' }] });

    await expect(readDiagnosticTestHistory(db, 'ai_model_status', 5)).resolves.toHaveLength(1);
    expect(db.calls).toEqual(expect.arrayContaining([['eq', 'test_id', 'ai_model_status'], ['limit', 5]]));
  });

  it('deletes by created_at cutoff and returns the exact count', async () => {
    const db = client({ counts: { deleted: 3 } });

    await expect(deleteOldDiagnosticResults(db, 30)).resolves.toBe(3);
    expect(db.calls).toContainEqual(['delete', { count: 'exact' }]);
    expect(db.calls.find(call => call[0] === 'lt')?.[1]).toBe('created_at');
  });

  it.each([
    ['latest', (db: any) => readLatestDiagnosticResults(db)],
    ['summary', (db: any) => readDiagnosticSummary(db, 24)],
    ['history', (db: any) => readDiagnosticTestHistory(db, 'x', 1)],
    ['cleanup', (db: any) => deleteOldDiagnosticResults(db, 30)],
  ])('throws on %s read errors instead of returning empty data', async (_name, run) => {
    await expect(run(client({ error: { code: '42501' } }))).rejects.toThrow(/diagnostic_results/);
  });

  it('reports the legacy-chat runtime proof as retired instead of "no recent requests"', async () => {
    const proof = await loadLatestRuntimeProof(client({ error: { code: '42501' } }), 72);

    expect(proof).toMatchObject({ found: false, status: 'warning' });
    expect(proof.message).toContain('LEGACY-CLOSE');
  });
});
