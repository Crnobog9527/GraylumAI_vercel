/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * DB-PERF PR-3: a new admission reads every system setting it needs in one query (admissionConfiguration.ts) and hands
 * the rows to each reader, which then sees exactly what its own query would have returned, error included. Without
 * the rows a reader queries as before: execution, the per-call pause and rate gate and every other caller read fresh.
 * The rows belong to one admission request and are never kept across requests.
 */
export type SettingRow = {key: string; value: unknown; raw?: string | null};
export type ConfigurationRows = {data: SettingRow[] | null; error: unknown};

/** The rows for `keys`, as `.select('key,value').in('key', keys)` would return them. */
export function rowsFor(rows: ConfigurationRows, keys: readonly string[]): ConfigurationRows {
  if (rows.error) return {data: null, error: rows.error};
  return {data: (rows.data ?? []).filter(row => keys.includes(row.key)), error: null};
}

/** The row for `key`, as `.select('value').eq('key', key).maybeSingle()` would return it. */
export function rowFor(rows: ConfigurationRows, key: string): {data: SettingRow | null; error: unknown} {
  if (rows.error) return {data: null, error: rows.error};
  return {data: (rows.data ?? []).find(row => row.key === key) ?? null, error: null};
}
