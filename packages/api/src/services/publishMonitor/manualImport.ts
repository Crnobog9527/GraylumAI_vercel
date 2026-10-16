/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { publicHttpsUrl } from './postForMe/http';

/**
 * PUBLISH-MONITOR PR-3b (plan §4.3): manual import of rows the user has already confirmed line by line, from a table
 * export (CSV/XLSX, parsed and column-mapped in the browser) or typed in next to a post link. The server re-validates
 * every row; the browser parse is a convenience, never trusted. Stored as source 'manual' (migration 0272), never
 * merged with automatically read numbers. No model call and no credits: screenshot recognition is PR-3c.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;

/** Metrics a manual row may carry: counts, plus completion rate as a percentage (0-100). Blank means absent. */
export const MANUAL_METRICS = ['views', 'impressions', 'reach', 'likes', 'comments', 'shares', 'saves',
  'followers_gained', 'profile_visits', 'completion_rate'] as const;
export type ManualMetric = (typeof MANUAL_METRICS)[number];
export const MAX_ROWS_PER_CALL = 200;
const MAX_COUNT = 1e12;

const metricValue = z.number().finite().nonnegative().max(MAX_COUNT);
const metrics = z.partialRecord(z.enum(MANUAL_METRICS), metricValue)
  .refine(value => Object.keys(value).length > 0, 'METRICS_EMPTY')
  .refine(value => value.completion_rate === undefined || value.completion_rate <= 100, 'COMPLETION_RATE');
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
/** An ISO instant with a zone and a real calendar date: 2026-02-30 is refused, never rolled over. */
function strictInstant(value: string): boolean {
  const m = ISO.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as number[];
  const day = new Date(Date.UTC(y!, mo! - 1, d!));
  const offset = /^[+-](\d{2}):(\d{2})$/.exec(m[7]!);
  return y! >= 2000 && y! <= 2100 && day.getUTCMonth() === mo! - 1 && day.getUTCDate() === d! && h! < 24 && mi! < 60
    && s! < 60 && (!offset || (+offset[1]! <= 14 && +offset[2]! < 60)) && Number.isFinite(Date.parse(value));
}
const iso = z.string().max(64).refine(strictInstant, 'DATE').transform(value => new Date(value).toISOString());

export const manualRow = z.object({
  /** The platform post ID when known, otherwise the post link. */
  postKey: z.string().trim().min(1).max(256),
  url: z.string().max(2048).nullable(),
  postedAt: iso.nullable(),
  titleExcerpt: z.string().max(400).nullable(),
  metrics,
}).strict().transform((row, ctx) => {
  const url = row.url === null ? null : publicHttpsUrl(row.url);
  if (row.url !== null && url === null) ctx.addIssue({ code: 'custom', message: 'URL' });
  const title = row.titleExcerpt?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || null;
  return { ...row, url, titleExcerpt: title ? [...title].slice(0, 120).join('') : null };
});
export type ManualRow = z.input<typeof manualRow>;

export const manualImportInput = z.object({
  accountProjectId: z.string().uuid(),
  origin: z.enum(['table', 'link']),
  rows: z.array(manualRow).min(1).max(MAX_ROWS_PER_CALL),
}).strict().refine(input => input.origin !== 'link' || input.rows.every(row => row.url !== null), 'LINK_REQUIRED');

export type ManualImportErrorCode = 'PUBLISH_MONITOR_ACCOUNT_CLOSED' | 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND'
  | 'PUBLISH_MONITOR_IMPORT_INVALID' | 'PUBLISH_MONITOR_UNAVAILABLE';
export class ManualImportError extends Error {
  constructor(readonly code: ManualImportErrorCode) { super(code); }
}

const resultSchema = z.object({ connectionId: z.string().uuid(), inserted: z.number().int().min(0),
  updated: z.number().int().min(0) }).strict();

export async function importManualRows(db: Rpc, profileId: string, input: z.input<typeof manualImportInput>) {
  const parsed = manualImportInput.safeParse(input);
  if (!parsed.success) throw new ManualImportError('PUBLISH_MONITOR_IMPORT_INVALID');
  const { accountProjectId, origin, rows } = parsed.data;
  const result = await db.rpc('publish_monitor_manual_import', { a: z.string().uuid().parse(profileId),
    p_account_project_id: accountProjectId, p_origin: origin, p_rows: rows });
  if (result.error) {
    const message = result.error.message ?? '';
    if (message.includes('PUBLISH_MONITOR_ACCOUNT_CLOSED')) throw new ManualImportError('PUBLISH_MONITOR_ACCOUNT_CLOSED');
    if (message.includes('PUBLISH_MONITOR_ACCOUNT_NOT_FOUND')) throw new ManualImportError('PUBLISH_MONITOR_ACCOUNT_NOT_FOUND');
    if (message.includes('PUBLISH_MONITOR_INPUT_INVALID')) throw new ManualImportError('PUBLISH_MONITOR_IMPORT_INVALID');
    throw new ManualImportError('PUBLISH_MONITOR_UNAVAILABLE');
  }
  const out = resultSchema.safeParse(result.data);
  if (!out.success) throw new ManualImportError('PUBLISH_MONITOR_UNAVAILABLE');
  return out.data;
}
