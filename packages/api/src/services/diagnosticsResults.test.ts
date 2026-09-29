import { describe, expect, it } from 'vitest';
import { loadLatestRuntimeProof } from './diagnostics';
import {
  deleteOldDiagnosticResults,
  readDiagnosticSummary,
  readDiagnosticTestHistory,
  readLatestDiagnosticResults,
} from './diagnosticsResults';

type Row = { id: string; test_id: string; status: string; latency_ms: number | null; created_at: string };

// In-memory diagnostic_results that honours eq/gte/lt, order, limit, range and PostgREST's 1000-row cap.
function table(rows: Row[], options: { error?: { code: string }; onRead?: () => void } = {}) {
  const reads: Array<{ range?: [number, number]; limit?: number }> = [];
  const db = {
    reads,
    from() {
      const filters: Array<(row: Row) => boolean> = [];
      const orders: Array<[keyof Row, boolean]> = [];
      let limit: number | undefined;
      let range: [number, number] | undefined;
      let deleting = false;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: keyof Row, value: unknown) => { filters.push(row => row[column] === value); return builder; },
        gte: (column: keyof Row, value: string) => { filters.push(row => String(row[column]) >= value); return builder; },
        lt: (column: keyof Row, value: string) => { filters.push(row => String(row[column]) < value); return builder; },
        order: (column: keyof Row, opts: { ascending: boolean }) => { orders.push([column, opts.ascending]); return builder; },
        limit: (value: number) => { limit = value; return builder; },
        range: (from: number, to: number) => { range = [from, to]; return builder; },
        delete: () => { deleting = true; return builder; },
        then: (resolve: (value: unknown) => unknown) => {
          if (options.error) return Promise.resolve({ data: null, count: null, error: options.error }).then(resolve);
          reads.push({ range, limit });
          options.onRead?.();
          let matched = rows.filter(row => filters.every(filter => filter(row)));
          if (deleting) {
            for (const row of matched) rows.splice(rows.indexOf(row), 1);
            return Promise.resolve({ data: null, count: matched.length, error: null }).then(resolve);
          }
          matched = [...matched].sort((a, b) => {
            for (const [column, ascending] of orders) {
              const cmp = String(a[column]).localeCompare(String(b[column]));
              if (cmp !== 0) return ascending ? cmp : -cmp;
            }
            return 0;
          });
          const start = range?.[0] ?? 0;
          const end = Math.min(range ? range[1] + 1 : matched.length, start + (limit ?? 1000), start + 1000);
          return Promise.resolve({ data: matched.slice(start, end), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return db as any;
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 0, 0, 0) + minute * 60_000).toISOString();
const row = (n: number, testId: string, status = 'passed', latency: number | null = 10): Row =>
  ({ id: `r${String(n).padStart(6, '0')}`, test_id: testId, status, latency_ms: latency, created_at: at(n) });

describe('diagnostics results without the 0005 view/RPCs', () => {
  it('keeps every defined test even when one test fills the newest 1000+ rows', async () => {
    const rows = [row(0, 'b', 'failed'), row(1, 'c', 'warning')];
    for (let n = 2; n < 1600; n += 1) rows.push(row(n, 'a'));
    const latest = await readLatestDiagnosticResults(table(rows), ['a', 'b', 'c', 'never_run']);

    expect(latest.map(r => [r.test_id, r.status])).toEqual([['a', 'passed'], ['c', 'warning'], ['b', 'failed']]);
    expect(latest[0].created_at).toBe(at(1599));
  });

  it('pages through a window larger than 1000 rows and derives every field from the same rows', async () => {
    const rows: Row[] = [];
    for (let n = 0; n < 2500; n += 1) {
      rows.push(row(n, `t${n % 20}`, n % 10 === 0 ? 'failed' : n % 10 === 1 ? 'warning' : 'passed', n % 2 ? 20 : null));
    }
    const since = Date.now;
    Date.now = () => Date.parse(at(2500));
    try {
      const db = table(rows);
      const summary = await readDiagnosticSummary(db, 168);
      expect(db.reads.map((read: { range?: [number, number] }) => read.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
      expect(summary).toEqual({
        total_tests: 2500, passed_tests: 2000, failed_tests: 250, warning_tests: 250,
        pass_rate: 80, avg_latency_ms: 20, last_run: at(2499),
      });
    } finally {
      Date.now = since;
    }
  });

  it('stays self-consistent when rows are written while the summary is being read', async () => {
    const rows: Row[] = [];
    for (let n = 0; n < 1500; n += 1) rows.push(row(n, 't', n % 3 === 0 ? 'failed' : 'passed'));
    let extra = 5000;
    const db = table(rows, { onRead: () => { for (let i = 0; i < 50; i += 1) rows.push(row(extra++, 't', 'passed')); } });
    const since = Date.now;
    Date.now = () => Date.parse(at(9000));
    try {
      const summary = await readDiagnosticSummary(db, 168);
      expect(summary.passed_tests + summary.failed_tests + summary.warning_tests).toBeLessThanOrEqual(summary.total_tests);
      expect(summary.passed_tests).toBeLessThanOrEqual(summary.total_tests);
      expect(summary.pass_rate).toBeLessThanOrEqual(100);
      expect(summary.total_tests).toBeGreaterThanOrEqual(1500);
    } finally {
      Date.now = since;
    }
  });

  it('fails instead of returning partial statistics when the window exceeds the page bound', async () => {
    const rows: Row[] = [];
    for (let n = 0; n < 50_001; n += 1) rows.push(row(n, 't'));
    const since = Date.now;
    Date.now = () => Date.parse(at(60_000));
    try {
      await expect(readDiagnosticSummary(table(rows), 168 * 100)).rejects.toThrow(/summary window too large/);
    } finally {
      Date.now = since;
    }
  });

  it('returns a zero summary for an empty window', async () => {
    await expect(readDiagnosticSummary(table([]), 1)).resolves.toMatchObject({
      total_tests: 0, pass_rate: 0, avg_latency_ms: 0, last_run: null,
    });
  });

  it('reads one test history newest first with the limit', async () => {
    const history = await readDiagnosticTestHistory(table([row(1, 'x'), row(2, 'y'), row(3, 'x')]), 'x', 1);
    expect(history.map(r => r.id)).toEqual(['r000003']);
  });

  it('deletes only rows older than the cutoff and returns the exact count', async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const rows = [{ ...row(0, 'x'), created_at: old }, { ...row(1, 'x'), created_at: new Date().toISOString() }];
    await expect(deleteOldDiagnosticResults(table(rows), 30)).resolves.toBe(1);
    expect(rows).toHaveLength(1);
  });

  it.each([
    ['latest', (db: any) => readLatestDiagnosticResults(db, ['x'])],
    ['summary', (db: any) => readDiagnosticSummary(db, 24)],
    ['history', (db: any) => readDiagnosticTestHistory(db, 'x', 1)],
    ['cleanup', (db: any) => deleteOldDiagnosticResults(db, 30)],
  ])('throws on %s read errors instead of returning empty data', async (_name, run) => {
    await expect(run(table([], { error: { code: '42501' } }))).rejects.toThrow(/diagnostic_results/);
  });

  it('reports the legacy-chat runtime proof as retired instead of "no recent requests"', async () => {
    const legacy = { from: () => {
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'gte', 'order', 'limit']) builder[method] = () => builder;
      builder.maybeSingle = async () => ({ data: null, error: { code: '42501' } });
      return builder;
    } } as any;
    const proof = await loadLatestRuntimeProof(legacy, 72);

    expect(proof).toMatchObject({ found: false, status: 'warning' });
    expect(proof.message).toContain('LEGACY-CLOSE');
  });
});
