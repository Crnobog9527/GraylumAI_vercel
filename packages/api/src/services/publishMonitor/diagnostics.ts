/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { RATE_KEYS } from './coach/funnel';

/**
 * PUBLISH-MONITOR RC: the single-post diagnosis layer, entered by hand (Owner 2026-10-27 item 7: the user types the platform back-office
 * rates of a post, gives the post's opening lines, sees them again and confirms; confirming is the save). The browser turns the
 * percentages the user types into fractions; the server checks every number again and the database function checks them a third time.
 * A blank rate is absent, never zero. No model, no credits: reading a screenshot is a separate step that ends in this same save.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;

const rate = z.number().finite().min(0);
export const diagnosticInput = z.object({
  postId: z.string().uuid(),
  rates: z.partialRecord(z.enum(RATE_KEYS), rate)
    .refine(value => Object.keys(value).length > 0, 'RATES_EMPTY')
    .refine(value => Object.entries(value).every(([key, v]) => v !== undefined && v <= (key === 'avg_watch_seconds' ? 86_400 : 1)),
      'RATE_RANGE'),
  openingText: z.string().max(4000).nullable().default(null),
  videoSeconds: z.number().int().min(1).max(86_400).nullable().default(null),
  dropSecond: z.number().int().min(0).max(86_400).nullable().default(null),
  capturedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** 'screenshot': a model read the numbers from a picture and the user confirmed them; it brings the labels as read, the picture's
   * storage key (kept until it is deleted) and the read's request id. 'manual' (the default) carries none of them. */
  source: z.enum(['manual', 'screenshot']).default('manual'),
  ratesRaw: z.record(z.string().max(80), z.union([z.number().finite(), z.string().max(80)])).nullable().default(null)
    .refine(value => value === null || Object.keys(value).length <= 50, 'RAW_TOO_MANY'),
  screenshotAsset: z.string().min(1).max(512).nullable().default(null),
  readRunId: z.string().uuid().nullable().default(null),
}).strict()
  .refine(input => input.videoSeconds === null || input.dropSecond === null || input.dropSecond <= input.videoSeconds, 'DROP_AFTER_END')
  .refine(input => input.source === 'screenshot'
    || (input.ratesRaw === null && input.screenshotAsset === null && input.readRunId === null), 'MANUAL_HAS_READ_FIELDS');
export type DiagnosticInput = z.input<typeof diagnosticInput>;
export const diagnosticDeleteInput = z.object({ id: z.string().uuid() }).strict();

export type DiagnosticErrorCode = 'PUBLISH_MONITOR_IMPORT_INVALID' | 'PUBLISH_MONITOR_POST_NOT_FOUND' | 'PUBLISH_MONITOR_UNAVAILABLE';
export class DiagnosticError extends Error {
  constructor(readonly code: DiagnosticErrorCode) { super(code); }
}

const candidate = z.object({ postId: z.string().uuid(), platform: z.string(), title: z.string().nullable(), postedAt: z.string().nullable(),
  businessId: z.string().uuid(), businessName: z.string(), diagnosedOn: z.string().nullable() }).passthrough();
const saved = z.object({ id: z.string().uuid(), postId: z.string().uuid(), platform: z.string(), title: z.string().nullable(),
  businessId: z.string().uuid(), rates: z.record(z.string(), z.number()), openingText: z.string().nullable(), videoSeconds: z.number().nullable(),
  dropSecond: z.number().nullable(), capturedOn: z.string(), confirmedAt: z.string(), source: z.string() }).passthrough();

async function call<T>(db: Rpc, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const result = await db.rpc(name, args);
  if (result.error) {
    const message = result.error.message ?? '';
    if (message.includes('PUBLISH_MONITOR_POST_NOT_FOUND')) throw new DiagnosticError('PUBLISH_MONITOR_POST_NOT_FOUND');
    if (message.includes('PUBLISH_MONITOR_INPUT_INVALID')) throw new DiagnosticError('PUBLISH_MONITOR_IMPORT_INVALID');
    throw new DiagnosticError('PUBLISH_MONITOR_UNAVAILABLE');
  }
  const out = schema.safeParse(result.data);
  if (!out.success) throw new DiagnosticError('PUBLISH_MONITOR_UNAVAILABLE');
  return out.data;
}

export const listCandidates = (db: Rpc, profileId: string) =>
  call(db, 'publish_monitor_diagnostic_candidates', { a: z.string().uuid().parse(profileId) }, z.array(candidate).max(30));
export const listDiagnostics = (db: Rpc, profileId: string) =>
  call(db, 'publish_monitor_diagnostics', { a: z.string().uuid().parse(profileId) }, z.array(saved).max(30));

export async function saveDiagnostic(db: Rpc, profileId: string, input: DiagnosticInput) {
  const parsed = diagnosticInput.safeParse(input);
  if (!parsed.success) throw new DiagnosticError('PUBLISH_MONITOR_IMPORT_INVALID');
  const { postId, rates, openingText, videoSeconds, dropSecond, capturedOn, source, ratesRaw, screenshotAsset, readRunId } = parsed.data;
  const text = openingText?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, '').trim() || null;
  if (text !== null && [...text].length > 2000) throw new DiagnosticError('PUBLISH_MONITOR_IMPORT_INVALID');
  return call(db, 'publish_monitor_diagnostic_save', { a: z.string().uuid().parse(profileId), p_post: postId, p_rates: rates, p_opening: text,
    p_video: videoSeconds, p_drop: dropSecond, p_captured: capturedOn, p_source: source, p_rates_raw: ratesRaw,
    p_screenshot_asset: screenshotAsset, p_read_run: readRunId }, z.object({ id: z.string().uuid(), capturedOn: z.string() }).strict());
}

export async function deleteDiagnostic(db: Rpc, profileId: string, input: z.input<typeof diagnosticDeleteInput>) {
  const parsed = diagnosticDeleteInput.safeParse(input);
  if (!parsed.success) throw new DiagnosticError('PUBLISH_MONITOR_IMPORT_INVALID');
  return call(db, 'publish_monitor_diagnostic_delete', { a: z.string().uuid().parse(profileId), p_id: parsed.data.id }, z.boolean());
}
