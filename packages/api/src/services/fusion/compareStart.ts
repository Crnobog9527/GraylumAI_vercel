/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PositioningClassifier } from '../runtime/positioningGate';
import { admitCompareGroup, assertCompareAllowed, assertQuoteCovers, buildCompareColumns, compareRpc, overCompareBudget, replayCompareGroup,
  type CompareAdmitted } from './compareAdmission';
import { judgeCompareGate, readCompareGate, staticCompareGate } from './compareGate';
import { compareRequest, snapshotHash, workspaceDependencies, type CompareParts } from './compareSnapshot';
import { swallow } from '../../lib/swallow';

/** FUSION-COMPARE §3.1–3.2: the estimate shown before the user agrees, and the start that records the request, makes the
 * one paid positioning judgement, then admits and claims the group. Everything here is injected or read through the
 * admin client; nothing is held until the group claim at the very end. */
export type CompareDeps = { admin: SupabaseClient; actorId: string; env?: Record<string, string | undefined>;
  /** Refuses with the positioning guide (POSITIONING_REQUIRED); injected so this module owns no UI wording. */
  refusePositioning: () => never;
  /** The platform OpenRouter key bound to the window account, for Decisions; undefined means "unavailable". */
  decisionsKey: () => Promise<string | undefined>;
  classify?: PositioningClassifier;
  /** The ordinary per-user message rate limit (newWorkGate.message): throws when the user is over it. Called once per new
   * request, before the paid judgement, so a refused or blocked request cannot be repeated without bound. */
  rateLimit: () => Promise<void> };
export type CompareChoice = { sessionId: string; historyRevision: number; modelIds: string[]; parts: CompareParts;
  /** The session's work-material token read with the context (fusion_compare_context.materialRevision), never defaulted:
   * begin, admission and adoption compare against it. */
  materialRevision: string };
/** First version: library documents referenced with @ are not offered to a compare. Their text would be frozen into the
 * runs without being registered for the library-erasure path, so a deleted document could stay in a stored payload. */
const assertNoReferences = (parts: CompareParts) => { if (parts.references.length) throw new Error('FUSION_COMPARE_REFERENCES_UNSUPPORTED'); };
export type CompareEstimate = { credits: number; columns: Array<{ modelId: string; credits: number; usd: string }>;
  tooLarge: string[]; refundCapReached: boolean;
  /** The columns together would exceed the administrator's single-compare budget: the page offers fewer models. */
  overBudget: boolean };

/** Admission failures after which the compare record stays: unknown/unavailable ones and those about the request's identity. */
const KEEP_RECORD = new Set(['FUSION_ADMISSION_UNAVAILABLE', 'FUSION_COMPARE_REQUEST_CONFLICT', 'FUSION_GROUP_CONFLICT',
  'BILL2_REQUEST_CONFLICT', 'FUSION_COMPARE_ENDED', 'FUSION_COMPARE_DENIED', 'FUSION_COMPARE_ACTIVE']);
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The estimate is always priced with the positioning fallback rule included: it is the larger of the two possible
 * requests, so what the user sees is never below what a start can hold. */
const upperRequest = (parts: CompareParts) => compareRequest({ ...parts, positioningFallback: true });

export async function estimateCompare(deps: CompareDeps, choice: CompareChoice): Promise<CompareEstimate> {
  assertNoReferences(choice.parts);
  const settings = await assertCompareAllowed(deps.admin, deps.actorId, choice.modelIds);
  // Free checks only: the paid judgement happens once, at start (a request id can repeat it never).
  const gate = await readCompareGate(deps.admin, deps.actorId);
  const { refundCapReached } = staticCompareGate(gate, choice.parts.skill, deps.refusePositioning);
  const built = await buildCompareColumns({ admin: deps.admin, actorId: deps.actorId, modelIds: choice.modelIds,
    request: upperRequest(choice.parts), answerTokens: settings.answerOutputTokens, dispatchMinutes: settings.dispatchMinutes, env: deps.env });
  const overBudget = overCompareBudget(built, settings.maxBudgetUsd);
  return { credits: built.totalCredits, tooLarge: built.tooLarge, refundCapReached, overBudget,
    columns: built.columns.map(column => ({ modelId: column.modelId, credits: column.upperCredits, usd: column.upperUsd })) };
}

export type CompareStarted =
  | { state: 'claimed' | 'waiting_credits'; compareId: string; group: CompareAdmitted; claim: unknown }
  | { state: 'processing'; compareId: string };

type RecordView = { compareId: string; state: string; gateVerdict: string | null; gateFallback?: boolean | null; groupId: string | null;
  created?: boolean; snapshotHash?: string; config?: { answerOutputTokens?: number } };

/** Records the request, judges positioning once, then admits and claims the group. `shown` is the estimate the user agreed
 * to; the group never holds more than it. A repeat of the same request id never judges again and returns the same group. */
export type CompareStartInput = CompareChoice & { requestId: string; shown: Pick<CompareEstimate, 'credits' | 'columns'> };
export async function startCompare(deps: CompareDeps, choice: CompareStartInput): Promise<CompareStarted> {
  try { return await beginCompare(deps, choice); }
  catch (error) {
    if (error instanceof Error && error.message === 'OPC_BUSINESS_ARCHIVED') {
      // Separate RPC: raising the refusal in the claim transaction rolls its writes back.
      // Resolve by request id so a replay can retry cleanup even if begin returns no compare id.
      await compareRpc(deps.admin, 'fusion_compare_stop_archived', {
        p_actor_id: deps.actorId, p_request_id: choice.requestId,
      });
    }
    throw error;
  }
}
async function beginCompare(deps: CompareDeps, choice: CompareStartInput): Promise<CompareStarted> {
  assertNoReferences(choice.parts);
  const { admin, actorId } = deps;
  const { requestId } = choice;
  // What identifies this request needs no pricing, so it is built first: a repeat of a request whose group already exists
  // must reach the frozen replay even if prices, the budget or a model's availability have changed since.
  const snapshot = snapshotHash(choice.parts);
  // The Skill identity is frozen whole (module, Skill and revision): adoption must carry the same one, however the module row changes.
  const skill = choice.parts.skill && { moduleId: choice.parts.skill.moduleId, skillId: choice.parts.skill.skillId,
    revisionId: choice.parts.skill.revisionId };
  const question = choice.parts.question;
  // The answer limit is recorded only with a new request; a repeat of an admitted one is answered from the stored record.
  const begin = (answerOutputTokens?: number) => {
    const config = { models: choice.modelIds, skill, ...(answerOutputTokens === undefined ? {} : { answerOutputTokens }),
      materialRevision: choice.materialRevision };
    return beginRecord(config);
  };
  const beginRecord = (config: Record<string, unknown>) => compareRpc<RecordView>(admin, 'fusion_compare_begin', { p_actor_id: actorId, p_request_id: requestId,
    p_session_id: choice.sessionId, p_request: { question, questionHash: createHash('sha256').update(question).digest('hex'),
      // Everything that identifies this request: a repeat with anything else is a conflict, never the old result.
      requestHash: sha([choice.sessionId, question, choice.modelIds, skill, choice.parts.references.map(r => [r.documentId, r.version]),
        // the frozen context too: a reused request id over a changed conversation, brief or source is a conflict, not the old group
        snapshot, choice.historyRevision, choice.materialRevision, workspaceDependencies(choice.parts),
        choice.shown.credits, choice.shown.columns.map(c => [c.modelId, c.credits, c.usd])]),
      snapshotHash: snapshot, historyRevision: String(choice.historyRevision), config,
      workspaceDependencies: workspaceDependencies(choice.parts) } });
  const claim = (compareId: string, group: CompareAdmitted) => compareRpc<{ state: 'claimed' | 'waiting_credits' }>(admin,
    'fusion_compare_claim', { p_actor_id: actorId, p_compare_id: compareId,
      p_items: group.runs.map(run => ({ runId: run.runId, sequence: 1, payload: run.call })) });
  // Ending a refused record gives the user's one compare slot back now. Failing that (logged), nothing is held: the slot frees
  // itself, since an admitting record only counts as active for five minutes (fusion_compare_active), and is reported as refused.
  const endQuietly = (compareId: string) => swallow('fusion_compare_end_failed',
    compareRpc(admin, 'fusion_compare_end', { p_actor_id: actorId, p_compare_id: compareId }), undefined, { category: 'billing', compareId });

  // A group that already exists is frozen and its holds are taken (the first start's response may have been lost): nothing is
  // repriced, judged or admitted again. The request-hash check still applies, and an ended compare still answers as ended.
  // The live switch, allowlist, minimum and entitlement are not consulted for it: its holds are already taken and the client
  // must be able to recover the compare id and the results even if compare was switched off in the meantime.
  const existing = await replayCompareGroup(admin, actorId, requestId, choice.sessionId);
  if (existing) {
    const replayed = await begin();
    if (['refused', 'stopped', 'finished'].includes(replayed.state)) throw new Error('FUSION_COMPARE_ENDED');
    const result = await claim(replayed.compareId, existing);
    return { state: result.state, compareId: replayed.compareId, group: existing, claim: result };
  }

  const settings = await assertCompareAllowed(admin, actorId, choice.modelIds).catch(async (error: unknown) => {
    // This request may already be recorded (judged, no group yet) by an earlier attempt: the live rules now refuse it, so
    // the record is ended instead of holding the user's one slot for five minutes. The database applies the same rules,
    // so a request that was never recorded is refused there without creating anything.
    const recorded = await swallow('fusion_compare_record_read_failed', begin(), null, { category: 'billing' });
    if (recorded && recorded.groupId === null && recorded.state === 'admitting') {
      await endQuietly(recorded.compareId);
    }
    throw error;
  });
  const gate = await readCompareGate(admin, actorId);
  staticCompareGate(gate, choice.parts.skill, deps.refusePositioning);
  const record = await begin(settings.answerOutputTokens);
  const compareId = record.compareId;
  if (record.state === 'refused' || record.state === 'stopped' || record.state === 'finished') {
    if (record.gateVerdict === 'block') deps.refusePositioning();
    throw new Error('FUSION_COMPARE_ENDED');
  }

  // A request seen for the first time is sized here, before the paid judgement: size, the single-compare budget, and the
  // whole quote the user was shown (count, order, total and per-column credits and provider cost), with the fallback rule
  // only when this user can be admitted with it. A refusal ends the record so it does not occupy the user's one slot. A
  // resumed request is never re-sized with today's settings: it keeps the limit and fallback recorded with it.
  if (record.created !== false) {
    try {
      const sized = await buildCompareColumns({ admin, actorId, modelIds: choice.modelIds,
        request: compareRequest({ ...choice.parts, positioningFallback: gate.gated && !gate.capped }),
        answerTokens: settings.answerOutputTokens, dispatchMinutes: settings.dispatchMinutes, env: deps.env });
      if (sized.tooLarge.length) throw new Error('FUSION_COMPARE_INPUT_TOO_LARGE');
      if (overCompareBudget(sized, settings.maxBudgetUsd)) throw new Error('FUSION_BUDGET_EXCEEDED');
      assertQuoteCovers(sized.columns, choice.shown);
    } catch (error) {
      await endQuietly(compareId);
      throw error;
    }
  }

  let verdict = record.gateVerdict;
  let fallback = false;
  if (verdict === null) {
    if (record.created === false) return { state: 'processing', compareId }; // another request of this id is judging
    // The only paid call of this start, made after the record exists so a repeat of the id cannot make a second one.
    // Over the rate limit: end this compare (nothing held, nothing judged) so it does not occupy the user's one slot.
    try { await deps.rateLimit(); }
    catch (error) {
      await endQuietly(compareId);
      throw error;
    }
    const key = await deps.decisionsKey();
    const outcome = await judgeCompareGate(gate, { text: question, apiKey: key }, deps.classify);
    // The fallback rule is part of the outcome: stored with the verdict, replayed as stored if this start is resumed.
    await compareRpc(admin, 'fusion_compare_gate', { p_actor_id: actorId, p_compare_id: compareId, p_verdict: outcome.verdict,
      p_fallback: outcome.fallback });
    if (outcome.refused) deps.refusePositioning();
    verdict = outcome.verdict;
    fallback = outcome.fallback;
  } else {
    if (verdict === 'block') deps.refusePositioning();
    // Resumed after the judgement: the rule the turn is admitted with is the one stored with the verdict, never rebuilt from
    // today's refund count (it may have changed since). Rows without it (none are written without) fall back to the gate.
    fallback = record.gateFallback ?? (gate.gated && !gate.capped);
    // Before the group exists the snapshot must be exactly the one first recorded: the user may have changed the
    // conversation or deleted a source since. Once the group exists this is a plain replay of frozen runs.
    if (record.groupId === null && record.snapshotHash && record.snapshotHash !== snapshot) {
      await compareRpc(admin, 'fusion_compare_end', { p_actor_id: actorId, p_compare_id: compareId });
      throw new Error('FUSION_COMPARE_STALE');
    }
  }

  const request = compareRequest({ ...choice.parts, positioningFallback: fallback });
  // Whatever refuses the admission definitively (the material or conversation changed while the judgement ran, the price,
  // budget or allowlist changed, the switch went off) ends the record so it does not hold the user's one slot for five
  // minutes: nothing was admitted or held, and a corrected request starts afresh. Only unknown or request-identity
  // failures keep it, because a retry of the same request may still succeed or must find the same group.
  const group = await admitCompareGroup({ admin, actorId, requestId, sourceSessionId: choice.sessionId, modelIds: choice.modelIds, request,
    env: deps.env, shown: choice.shown,
    // The limit recorded with the request, not today's setting: a change by an administrator in between must not shorten answers.
    answerTokens: record.config?.answerOutputTokens })
    .catch(async (error: unknown) => {
      if (!KEEP_RECORD.has(error instanceof Error ? error.message : '')) {
        await endQuietly(compareId);
      }
      throw error;
    });
  const result = await claim(compareId, group);
  return { state: result.state, compareId, group, claim: result };
}
