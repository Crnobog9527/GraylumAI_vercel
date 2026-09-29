/** Read a complete, deterministically ordered report source despite PostgREST row caps. */
export async function readAllReportRows<T, E>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: E | null }>,
  pageSize = 500,
): Promise<{ data: T[] | null; error: E | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await page(from, from + pageSize - 1);
    if (result.error || !Array.isArray(result.data)) return result;
    rows.push(...result.data);
    if (result.data.length < pageSize) return { data: rows, error: null };
  }
}
