/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PositioningClassifier } from '../runtime/positioningGate';
import { admitCompareGroup, assertCompareAllowed, buildCompareColumns, compareRpc, type CompareAdmitted } from './compareAdmission';
import { judgeCompareGate, readCompareGate, staticCompareGate } from './compareGate';
import { compareRequest, snapshotHash, workspaceDependencies, type CompareParts } from './compareSnapshot';

/** FUSION-COMPARE §3.1–3.2: the estimate shown before the user agrees, and the start that records the request, makes the
 * one paid positioning judgement, then admits and claims the group. Everything here is injected or read through the
 * admin client; nothing is held until the group claim at the very end. */
export type CompareDeps = { admin: SupabaseClient; actorId: string; env?: Record<string, string | undefined>;
  /** Refuses with the positioning guide (POSITIONING_REQUIRED); injected so this module owns no UI wording. */
  refusePositioning: () => never;
  /** The platform OpenRouter key bound to the window account, for Decisions; undefined means "unavailable". */
  decisionsKey: () => Promise<string | undefined>;
  classify?: PositioningClassifier };
export type CompareChoice = { sessionId: string; historyRevision: number; modelIds: string[]; parts: CompareParts };
export type CompareEstimate = { credits: number; columns: Array<{ modelId: string; credits: number; usd: string }>;
  tooLarge: string[]; refundCapReached: boolean };

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The estimate is always priced with the positioning fallback rule included: it is the larger of the two possible
 * requests, so what the user sees is never below what a start can hold. */
const upperRequest = (parts: CompareParts) => compareRequest({ ...parts, positioningFallback: true });

export async function estimateCompare(deps: CompareDeps, choice: CompareChoice): Promise<CompareEstimate> {
  const settings = await assertCompareAllowed(deps.admin, deps.actorId, choice.modelIds);
  // Free checks only: the paid judgement happens once, at start (a request id can repeat it never).
  const gate = await readCompareGate(deps.admin, deps.actorId);
  const { refundCapReached } = staticCompareGate(gate, choice.parts.skill, deps.refusePositioning);
  const built = await buildCompareColumns({ admin: deps.admin, actorId: deps.actorId, modelIds: choice.modelIds,
    request: upperRequest(choice.parts), answerTokens: settings.answerOutputTokens, dispatchMinutes: settings.dispatchMinutes, env: deps.env });
  return { credits: built.totalCredits, tooLarge: built.tooLarge, refundCapReached,
    columns: built.columns.map(column => ({ modelId: column.modelId, credits: column.upperCredits, usd: column.upperUsd })) };
}

export type CompareStarted =
  | { state: 'claimed' | 'waiting_credits'; compareId: string; group: CompareAdmitted; claim: unknown }
  | { state: 'processing'; compareId: string };

type RecordView = { compareId: string; state: string; gateVerdict: string | null; groupId: string | null; created?: boolean; snapshotHash?: string };

/** Records the request, judges positioning once, then admits and claims the group. `shown` is the estimate the user agreed
 * to; the group never holds more than it. A repeat of the same request id never judges again and returns the same group. */
export async function startCompare(deps: CompareDeps, choice: CompareChoice & { requestId: string; shown: CompareEstimate }): Promise<CompareStarted> {
  const { admin, actorId } = deps;
  const { requestId } = choice;
  const settings = await assertCompareAllowed(admin, actorId, choice.modelIds);
  const gate = await readCompareGate(admin, actorId);
  staticCompareGate(gate, choice.parts.skill, deps.refusePositioning);
  // Price and size with the worst-case request first: a refusal here costs nothing and records nothing.
  const upper = await buildCompareColumns({ admin, actorId, modelIds: choice.modelIds, request: upperRequest(choice.parts),
    answerTokens: settings.answerOutputTokens, dispatchMinutes: settings.dispatchMinutes, env: deps.env });
  if (upper.tooLarge.length) throw new Error('FUSION_COMPARE_INPUT_TOO_LARGE');
  if (upper.totalCredits > choice.shown.credits) throw new Error('FUSION_COMPARE_PRICE_CHANGED');

  const snapshot = snapshotHash(choice.parts);
  const skill = choice.parts.skill && { moduleId: choice.parts.skill.moduleId, revisionId: choice.parts.skill.revisionId };
  const question = choice.parts.question;
  const config = { models: choice.modelIds, skill, answerOutputTokens: settings.answerOutputTokens };
  const record = await compareRpc<RecordView>(admin, 'fusion_compare_begin', { p_actor_id: actorId, p_request_id: requestId,
    p_session_id: choice.sessionId, p_request: { question, questionHash: createHash('sha256').update(question).digest('hex'),
      // Everything that identifies this request: a repeat with anything else is a conflict, never the old result.
      requestHash: sha([choice.sessionId, question, choice.modelIds, skill, choice.parts.references.map(r => [r.documentId, r.version]),
        choice.shown.credits, choice.shown.columns.map(c => [c.modelId, c.credits, c.usd])]),
      snapshotHash: snapshot, historyRevision: String(choice.historyRevision), config,
      workspaceDependencies: workspaceDependencies(choice.parts) } });
  const compareId = record.compareId;
  if (record.state === 'refused' || record.state === 'stopped' || record.state === 'finished') {
    if (record.gateVerdict === 'block') deps.refusePositioning();
    throw new Error('FUSION_COMPARE_ENDED');
  }

  let verdict = record.gateVerdict;
  let fallback = false;
  if (verdict === null) {
    if (record.created === false) return { state: 'processing', compareId }; // another request of this id is judging
    // The only paid call of this start, made after the record exists so a repeat of the id cannot make a second one.
    const key = await deps.decisionsKey();
    const outcome = await judgeCompareGate(gate, { text: question, apiKey: key }, deps.classify);
    await compareRpc(admin, 'fusion_compare_gate', { p_actor_id: actorId, p_compare_id: compareId, p_verdict: outcome.verdict });
    if (outcome.refused) deps.refusePositioning();
    verdict = outcome.verdict;
    fallback = outcome.fallback;
  } else {
    if (verdict === 'block') deps.refusePositioning();
    // Resumed after the judgement. The rule the turn is admitted with follows from the stored verdict and today's
    // gate state (it only differs if a refused turn was refunded in between, which can only lower the count).
    fallback = gate.gated && !gate.capped;
    // Before the group exists the snapshot must be exactly the one first recorded: the user may have changed the
    // conversation or deleted a source since. Once the group exists this is a plain replay of frozen runs.
    if (record.groupId === null && record.snapshotHash && record.snapshotHash !== snapshot) {
      await compareRpc(admin, 'fusion_compare_end', { p_actor_id: actorId, p_compare_id: compareId });
      throw new Error('FUSION_COMPARE_STALE');
    }
  }

  const request = compareRequest({ ...choice.parts, positioningFallback: fallback });
  const group = await admitCompareGroup({ admin, actorId, requestId, sourceSessionId: choice.sessionId, modelIds: choice.modelIds, request,
    env: deps.env, shown: { credits: choice.shown.credits,
      columns: choice.shown.columns.map(column => ({ credits: column.credits, usd: column.usd })) } });
  const claim = await compareRpc<{ state: 'claimed' | 'waiting_credits' }>(admin, 'fusion_compare_claim', { p_actor_id: actorId,
    p_compare_id: compareId, p_items: group.runs.map(run => ({ runId: run.runId, sequence: 1, payload: run.call })) });
  return { state: claim.state, compareId, group, claim };
}
