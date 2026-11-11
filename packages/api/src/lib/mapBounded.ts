/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Runs `task` over `items`, at most `limit` at a time, and returns the results in the order of `items`.
 * The first failure rejects and no further item is started (tasks already running finish on their own).
 * For independent reads that used to run one after another: the bound keeps a request from taking the whole connection pool.
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index] as T, index); }
      catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(limit), items.length)) }, worker));
  return results;
}
