/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { repairActorRounds } from './automaticRecovery';

/** The SQL refusal of runtime_admit when an earlier round of this session still holds it (0106 and later). */
const SESSION_BUSY = 'RUNTIME_SESSION_BUSY';

/** Whether admission refused only because an earlier round still holds the session (admission.ts keeps the SQL error
 * as the cause of RUNTIME_ADMISSION_DENIED for exactly this refusal). */
export function sessionBusy(error: unknown): boolean {
  return error instanceof Error && error.message === 'RUNTIME_ADMISSION_DENIED'
    && (error.cause as { message?: unknown } | undefined)?.message === SESSION_BUSY;
}
/** The three admission functions: runtime_admit and, behind the DB-RW-C switch, its precheck and commit steps. */
export const isAdmitFunction = (name: string) => name === 'runtime_admit' || name === 'runtime_admit_precheck' || name === 'runtime_admit_commit';
/** The admission refusals whose SQL error admission keeps as the cause. */
export const keepsCause = (name: string, message: unknown) => isAdmitFunction(name) && (message === SESSION_BUSY || message === 'RUNTIME_ADMIT_STALE');
/** The cause admission attaches to RUNTIME_ADMISSION_DENIED: the SQL error for a report (as before) or a session-busy refusal. */
export const keptCause = (name: string, error: { message?: unknown }, report: unknown) =>
  report || keepsCause(name, error.message) ? error : undefined;

/**
 * Line D2 (architecture audit 2026-10-25): when the session is still held by an earlier round, run the actor-scoped,
 * time-limited recovery once (automaticRecovery.ts repairActorRounds) and, if it processed a round, admit once more with
 * the same request. The refused attempt rolled back entirely, so the retry is the same admission, not a second one.
 * If nothing was repaired or the retry is refused again, the original refusal stands and the user sees today's message.
 */
export async function admitWithRepair<T>(admin: SupabaseClient, actorId: string, admit: () => Promise<T>,
  repair?: typeof repairActorRounds): Promise<T> {
  try { return await admit(); }
  catch (error) {
    // The recovery is resolved only on this path, so an admission that is not refused this way never loads it.
    if (!sessionBusy(error) || !await (repair ?? repairActorRounds)(admin, actorId)) throw error;
    return admit();
  }
}
