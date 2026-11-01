/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

/*
 * CORE-PATH-V2 V2-10: the compare cards of a conversation on the turn path. A compare started on POST /api/turn/compare lives on
 * turns / turn_calls / fusion_turn_outputs; these three calls list, read and adopt it in the fields the card already reads (the
 * old fusionCompare router serves compares of the old path, which have no turn). Adoption writes the question and the chosen
 * answer into the conversation (fusion_compare_turn_adopt) and is free; a conversation that moved on hands the answer back as a
 * quote instead. Nothing here calls a model.
 */
type Adoption = { state?: string; seq?: number; column?: number; fromRevision?: number; toRevision?: number; replay?: boolean };
export type TurnCompareColumn = { column: number; runId: string; modelId: string; body: string | null;
  billing: { closed: boolean; state: string; reservedCredits: number; chargedCredits: number; netChargedCredits: number };
  call: { callId: number; state: string; dispatched: boolean; settled: boolean; verdict: string | null; inFlight: boolean } | null };
export type TurnCompareCard = { compareId: string; turnId: number; sessionId: string; state: string; question: string | null;
  config: { models?: string[] }; adoption: Adoption | null };
export type TurnCompareView = TurnCompareCard & { columns: TurnCompareColumn[]; chargedCredits: number };

const FIXED = /^FUSION_COMPARE_[A-Z_]+$/;
async function call<T>(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await admin.rpc(name, args);
  if (result.error) {
    const message = typeof result.error.message === 'string' ? result.error.message : '';
    throw new Error(FIXED.test(message) ? message : 'FUSION_ADMISSION_UNAVAILABLE');
  }
  return result.data as T;
}

/** The adoption as the card reads it: the column that holds the adopted answer (the database records its receipt's seq). */
const withColumn = (view: TurnCompareView): TurnCompareView => view.adoption && view.adoption.column === undefined
  ? { ...view, adoption: { ...view.adoption, column: view.columns.find(c => c.call?.callId === view.adoption?.seq)?.column } } : view;

export const listTurnCompares = (admin: SupabaseClient, actorId: string, sessionId: string) =>
  call<TurnCompareCard[]>(admin, 'fusion_compare_turn_list', { p_actor_id: actorId, p_session_id: sessionId });

export async function readTurnCompare(admin: SupabaseClient, actorId: string, compareId: string): Promise<TurnCompareView> {
  const view = await call<TurnCompareView | null>(admin, 'fusion_compare_turn_read', { p_actor_id: actorId, p_compare_id: compareId });
  if (!view) throw new Error('FUSION_COMPARE_DENIED');
  return withColumn(view);
}

/** "Use this answer": the same result shapes as the old adoption (`adopted`, or `stale` with the quote). */
export async function adoptTurnCompare(admin: SupabaseClient, actorId: string, input: { compareId: string; column: number }) {
  const view = await readTurnCompare(admin, actorId, input.compareId);
  const column = view.columns.find(c => c.column === input.column);
  if (!column?.body || !column.call) throw new Error('FUSION_COMPARE_INVALID');
  const done = await call<Adoption & { body?: string }>(admin, 'fusion_compare_turn_adopt',
    { p_actor_id: actorId, p_compare_id: input.compareId, p_seq: column.call.callId });
  if (done.state === 'quoted') return { state: 'stale' as const, quote: done.body ?? column.body };
  return { state: 'adopted' as const, adoption: { ...done, column: input.column } };
}
