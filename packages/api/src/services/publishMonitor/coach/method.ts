/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * The coach's method (how to read a pack, what to advise, how to write) lives in the published coach Skill package, `method.md`, and
 * is read from the same pinned package as the handbooks. This repository holds the contract the host checks (turn/review.ts) and this
 * reader, never the method text. A method that cannot be read is not replaced by an older copy in code: the weekly review waits
 * (nothing opened, nothing charged, tried again later) and the cause is logged as a fixed code, so a review that keeps waiting is seen.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../../lib/logger';
import { packageReader, readHandbookPackage } from './handbooks';

export const COACH_METHOD_PATH = 'method.md';
/** The method is one page of instructions; more than this is a wrong file, not a method. */
export const MAX_COACH_METHOD_BYTES = 12_288;
export type MethodUnavailable = 'NOT_CONFIGURED' | 'READ_FAILED' | 'EMPTY' | 'TOO_LARGE';
export type CoachMethod = { ok: true; text: string } | { ok: false; reason: MethodUnavailable };

/** Fixed codes only, never text: `surface` is where the method was wanted (the weekly review or the chat). */
export function logCoachMethodUnavailable(surface: 'review' | 'chat', reason: MethodUnavailable) {
  logger.warn('billing', 'coach_method_unavailable', { surface, reason });
}

/** Never throws. Read on every review (one small file, once a week per brand) so a revoked or replaced method applies at once. */
export async function loadCoachMethod(admin: Pick<SupabaseClient, 'rpc'>, env: Record<string, string | undefined>,
  surface: 'review' | 'chat' = 'review'): Promise<CoachMethod> {
  const fail = (reason: MethodUnavailable): CoachMethod => { logCoachMethodUnavailable(surface, reason); return { ok: false, reason }; };
  const pack = readHandbookPackage(env);
  if (!pack) return fail('NOT_CONFIGURED');
  let text: string | null;
  try { text = await packageReader(admin, pack)(COACH_METHOD_PATH); }
  catch { return fail('READ_FAILED'); }
  if (text === null || text.trim() === '') return fail('EMPTY');
  if (Buffer.byteLength(text) > MAX_COACH_METHOD_BYTES) return fail('TOO_LARGE');
  return { ok: true, text: text.trim() };
}
