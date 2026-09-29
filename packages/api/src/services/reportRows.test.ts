import { describe, expect, it } from 'vitest';
import { readAllReportRows } from './reportRows';

describe('readAllReportRows', () => {
  it('includes rows past the first database page, including an exact full page', async () => {
    const source = Array.from({ length: 1001 }, (_, id) => ({ id }));
    const result = await readAllReportRows(async (from, to) => ({
      data: source.slice(from, to + 1), error: null,
    }));
    expect(result.data).toHaveLength(1001);
    expect(result.data?.at(-1)).toEqual({ id: 1000 });
  });

  it('returns a later query error instead of a partial report', async () => {
    const result = await readAllReportRows(async (from) => from === 0
      ? { data: Array.from({ length: 500 }, (_, id) => id), error: null }
      : { data: null, error: 'database unavailable' });
    expect(result).toEqual({ data: null, error: 'database unavailable' });
  });
});
