/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** The commit step refuses with this when the session or the catalog moved after the precheck (0415). */
export const ADMIT_STALE = 'RUNTIME_ADMIT_STALE';

type Query = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type AdmitArgs = {p_session_id: string; p_request_id: string; p_payload: unknown; p_billing: unknown};

/** Whether admission's refusal wrapper carries the stale-proof refusal of runtime_admit_commit as its cause. */
export function admitStale(error: unknown): boolean {
  return error instanceof Error && error.message === 'RUNTIME_ADMISSION_DENIED'
    && (error.cause as {message?: unknown} | undefined)?.message === ADMIT_STALE;
}

/**
 * DB-RW-C: admit in two database calls. The precheck proves the turn may start without taking any row lock; the commit
 * writes the execution under the session lock and re-checks only what can have changed. A commit that finds the session
 * or the catalog changed since the proof (RUNTIME_ADMIT_STALE) is the same admission asked again once with a fresh
 * proof; the refused commit rolled back entirely. Anything else is surfaced as it is, exactly like runtime_admit's.
 */
export async function admitInTwoSteps(query: Query, args: AdmitArgs): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const proof = await query('runtime_admit_precheck', args) as {replay?: unknown} | null;
    if (proof?.replay) return proof.replay;
    try { return await query('runtime_admit_commit', {...args, p_pre: proof}); }
    catch (error) { if (attempt === 0 && admitStale(error)) continue; throw error; }
  }
}

/**
 * The admission call for this turn: the two-step path when runtime_rw_v2.admitSplit is true (off unless set),
 * today's single runtime_admit otherwise.
 */
export const admission = (split: boolean, query: Query, sessionId: string, requestId: string, payload: unknown, billing: unknown): (() => Promise<unknown>) => {
  const args = {p_session_id: sessionId, p_request_id: requestId, p_payload: payload, p_billing: billing};
  return split ? () => admitInTwoSteps(query, args) : () => query('runtime_admit', args);
};
