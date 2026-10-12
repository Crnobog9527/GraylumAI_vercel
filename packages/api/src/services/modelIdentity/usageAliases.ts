/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * MODEL-IDENTITY-GUARD (0217): token_stats stores an opaque alias ("m_<16 hex>") instead of the
 * provider model string, because clients can read their own token_stats rows. Admin reports
 * resolve aliases back through the server-only model_usage_aliases map (service role only).
 * Values that are not aliases (rows written before 0217 was applied) pass through unchanged.
 */
export const MODEL_USAGE_ALIAS = /^m_[0-9a-f]{16}$/;
const CHUNK = 200;

export async function resolveModelUsageAliases(admin: SupabaseClient, values: Iterable<string | null | undefined>) {
  const aliases = [...new Set([...values].filter((v): v is string => typeof v === 'string' && MODEL_USAGE_ALIAS.test(v)))];
  const map = new Map<string, string>();
  for (let i = 0; i < aliases.length; i += CHUNK) {
    const { data, error } = await admin.from('model_usage_aliases').select('alias,model').in('alias', aliases.slice(i, i + CHUNK));
    if (error || !data) throw new Error('MODEL_USAGE_ALIASES_UNAVAILABLE');
    for (const row of data as Array<{ alias: string; model: string }>) map.set(row.alias, row.model);
  }
  return map;
}

function collect(value: unknown, out: string[]) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => collect(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { out.push(key); collect(item, out); }
  }
}
function restore(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => restore(item, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [map.get(key) ?? key, restore(item, map)]));
  }
  return value;
}

/** Returns the rows with model_used and any aliased metadata value or key restored (admin reports only). */
export async function withRealModelUsed<T extends { model_used?: string | null; metadata?: unknown }>(
  admin: SupabaseClient, rows: T[]): Promise<T[]> {
  const values: string[] = [];
  for (const row of rows) { if (row.model_used) values.push(row.model_used); if (row.metadata) collect(row.metadata, values); }
  const map = await resolveModelUsageAliases(admin, values);
  if (!map.size) return rows;
  return rows.map(row => ({
    ...row,
    ...(typeof row.model_used === 'string' && map.has(row.model_used) ? { model_used: map.get(row.model_used)! } : {}),
    ...(row.metadata ? { metadata: restore(row.metadata, map) } : {}),
  }));
}

/** Same as withRealModelUsed for a { data, error } read result; a map failure becomes the result error. */
export async function withRealModelUsedResult<T extends { model_used?: string | null; metadata?: unknown }, E>(admin: SupabaseClient,
  pending: PromiseLike<{ data: T[] | null; error: E | null }>): Promise<{ data: T[] | null; error: E | Error | null }> {
  const result = await pending;
  if (result.error || !result.data) return result;
  try { return { data: await withRealModelUsed(admin, result.data), error: null }; }
  catch (error) { return { data: null, error: error as Error }; }
}

/** Diagnostics: best effort, falls back to the stored values when the map cannot be read. */
export async function realModelUsedOrStored<T extends { model_used?: string | null; metadata?: unknown }>(admin: SupabaseClient, rows: T[]) {
  return withRealModelUsed(admin, rows).catch(() => rows);
}
