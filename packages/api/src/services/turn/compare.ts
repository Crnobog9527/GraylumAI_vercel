/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logSwallowed } from '../../lib/swallow';
import { compareRequest, snapshotHash, workspaceDependencies, type CompareParts } from '../fusion/compareSnapshot';
import { columnStreamer } from '../fusion/compareStream';
import { fusionRequestBody } from '../fusion/request';
import { assertCompareAllowed, assertQuoteCovers, type ShownQuote } from '../fusion/compareAdmission';
import { readOpenRouterKeyOrUnset } from '../models/openRouterKey';
import { readAdmissionConfiguration } from '../runtime/admissionConfiguration';
import { rowFor } from '../runtime/settingsRows';
import { isPositioningRefusal } from '../runtime/positioningFallback';
import { judgePositioning, POSITIONING_REFUSAL_CAP, type PositioningGatePolicy } from '../runtime/positioningGate';
import type { PricingDeps } from '../runtime/pricingAdmission';
import { ceil12, TurnStop } from './call';
import { CORE_PATH_SETTING, GATE_CODES, type ChatDeps } from './chat';
import { readAdmissionSettings } from '../runtime/newWorkGate';
import { TurnDatabaseError, type TurnClients } from './db';
import { breakerTripped, fusionAdmission, fusionCoreSetting, fusionDatabase, fusionPolicy, runGroup, type MemberOutcome } from './fusionCalls';
import { priceCompareColumns } from './compareQuote';
import { fusionCall, fusionQuote } from './fusionQuote';
import type { CounterStore } from './limiter';
import { callCredits } from './policy';
import { QuoteError } from './quote';

/*
 * CORE-PATH-V2 kind=compare (2.7, FUSION-COMPARE): one turn of the conversation; N models answer the same request in
 * parallel, each column one call with its own receipt and its own rounding. Gold only; at least two models from the
 * administrator's allowlist; the columns' bounds together at most 500 credits (turn_fusion_open refuses otherwise) and within
 * the single-compare budget. A user without a confirmed positioning gets the positioning check first (a 'decision' call, never
 * charged to the user) and, below the refund cap, the fallback rule; a column that answers with the refusal is not shown and
 * costs the user nothing ('unusable'). The answers are saved with their receipts; the user adopts one into the conversation
 * later (fusion_compare_turn_adopt). Each column's bound is measured on its exact request, so the history is read first (the
 * read client, one query) and must be the history turn_open returns; if another turn changed it in between, nothing is sent.
 */
export const COMPARE_HISTORY_ITEMS = 100;
export type CompareEvent =
  | { type: 'opened'; turnId: number; compareId: string; reservedCredits: number; replay: boolean }
  | { type: 'column'; index: number; delta: string }
  | { type: 'answer'; index: number; ok: boolean; code?: string }
  | { type: 'result'; turnId: number; compareId: string; chargedCredits: number | null; settlement: 'pending' | 'done' | null }
  | { type: 'error'; code: string; turnId?: number };
export type CompareTurnDeps = { admin: SupabaseClient; clients: TurnClients; slots: CounterStore; transport?: typeof fetch;
  pricing?: PricingDeps; gate?: PositioningGatePolicy;
  /** The runtime rate limits and the one-switch pause, before the compare opens (message) and before each paid call (calls). */
  newWork: Pick<ChatDeps['newWork'], 'message' | 'calls'> };
export type CompareTurnParts = Omit<CompareParts, 'history' | 'positioningFallback'>;
export type CompareTurnInput = { actorId: string; sessionId: string; requestId: string; modelIds: string[];
  /** The estimate the user agreed to: the turn never freezes more (FUSION-COMPARE §3.1). */
  shown?: ShownQuote;
  /** Everything a column is sent except the history (read here) and the fallback rule (decided here); a reader runs after the gates. */
  parts: CompareTurnParts | (() => Promise<CompareTurnParts>) };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (code: string): CompareEvent => ({ type: 'error', code });

export async function runCompareTurn(deps: CompareTurnDeps, input: CompareTurnInput, emit: (event: CompareEvent) => void) {
  const { admin } = deps;
  // The settings come with the admission configuration (one cached query for every setting), never a query of their own.
  const configuration = await readAdmissionConfiguration(admin);
  const core = rowFor(configuration, CORE_PATH_SETTING);
  const config = fusionCoreSetting.safeParse(core.error ? null : core.data?.value);
  if (!config.success || !config.data.enabled) return emit(fail('TURN_CORE_DISABLED'));
  // The pause and the message limit before anything is priced or opened, as a free chat (the old compare start's rateLimit).
  const admitted = await deps.newWork.message(input.actorId, readAdmissionSettings(admin, Promise.resolve(configuration)));
  if (!admitted.ok) return emit(fail(GATE_CODES[admitted.reason]));
  // The BILL2 compare's admission rules (assertCompareAllowed): the switch, the live membership facts (not only the cached
  // level), at least min and at most the plan's maximum (and 8) models, each on the allowlist.
  const models = input.modelIds;
  let settings;
  try { settings = await assertCompareAllowed(admin, input.actorId, models); }
  catch (error) { return emit(fail(error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message) ? error.message : 'FUSION_COMPARE_UNAVAILABLE')); }
  const key = await readOpenRouterKeyOrUnset(admin, { fresh: true });
  if (!key) return emit(fail('TURN_PROVIDER_KEY_UNAVAILABLE'));
  let parts;
  try { parts = typeof input.parts === 'function' ? await input.parts() : input.parts; }
  catch (error) { return emit(fail(error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message) ? error.message : 'FUSION_COMPARE_UNAVAILABLE')); }

  // 1. Read before the open (fusion_compare_turn_admit): the history the turn will see, for sizing (turn_open returns the
  // authoritative copy); the business writable, the sources allowed, the positioning and the 7-day breaker.
  let admit;
  try { admit = await fusionAdmission(deps.clients, input.actorId).compare(input.sessionId, COMPARE_HISTORY_ITEMS,
    workspaceDependencies(parts)); }
  catch (error) { return emit(fail(error instanceof TurnDatabaseError ? error.code : 'TURN_DATABASE_UNAVAILABLE')); }
  if (breakerTripped(admit.breaker, settings.breaker)) return emit(fail('FUSION_REVIEW_BREAKER'));
  const sized = admit.history;
  const partsWith = (history: Array<{ role: 'user' | 'assistant'; content: string }>, positioningFallback: boolean): CompareParts =>
    ({ ...parts, history: history.map(m => ({ role: m.role, text: m.content })), positioningFallback });

  // 2. Quotes and the exact request of every column (priceCompareColumns, the estimate's computation), and what the user agreed to.
  let quotes, priced;
  try {
    quotes = await Promise.all(models.map(modelId => fusionQuote(admin, { configuration, modelId, phase: 'fusion_compare',
      outputTokens: settings.answerOutputTokens, key, deps: deps.pricing })));
    priced = priceCompareColumns({ quotes, parts: partsWith(sized, true), answerTokens: settings.answerOutputTokens, maxBudgetUsd: settings.maxBudgetUsd });
    if (priced.tooLarge.length) throw new Error('FUSION_COMPARE_INPUT_TOO_LARGE');
    if (priced.overBudget) throw new Error('FUSION_BUDGET_EXCEEDED');
    if (input.shown) assertQuoteCovers(priced.columns, input.shown);
  } catch (error) {
    // A known refusal code (quote, reasoning, price snapshot, request shape) is passed on; anything else stays generic.
    return emit(fail(error instanceof QuoteError || error instanceof TurnStop ? error.code
      : error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message) ? error.message : 'TURN_QUOTE_UNAVAILABLE'));
  }
  const { q, credits: gCredits } = priced;
  const columns = priced.columns.map(column => column.call);
  const credits = priced.columns.map(column => column.upperCredits);

  // 3. Open: Gold, >= 2 models, <= 500 credits, one compare at a time; the compare record; the freeze of every column.
  const db = fusionDatabase(deps.clients, input.actorId);
  const decisionUpper = String((config.data as { decisionUpperUsd?: unknown }).decisionUpperUsd ?? '');
  if (!/^0\.\d{1,12}$/.test(decisionUpper)) return emit(fail('TURN_CORE_DISABLED'));
  const policy = fusionPolicy({ q, calls: columns, gCredits, minCredits: gCredits, stopLoss: config.data.stopLoss,
    decisionUpperUsd: decisionUpper, historyItems: COMPARE_HISTORY_ITEMS, quotes });
  let opened;
  try {
    opened = await db.open({ sessionId: input.sessionId, requestId: input.requestId, kind: 'compare', policy, product: {
      question: parts.question, questionHash: sha256(parts.question), snapshotHash: snapshotHash(partsWith(sized, false)),
      requestHash: sha256(JSON.stringify([input.sessionId, models, parts.question, credits])), config: { models },
      // The sources the columns read: content deletion of a source finds this compare by them (content_erasure_confirm).
      workspaceDependencies: workspaceDependencies(parts) } });
  } catch (error) { return emit(fail(error instanceof TurnDatabaseError ? error.code : 'TURN_OPEN_FAILED')); }
  const compareId = opened.compareId!;
  emit({ type: 'opened', turnId: opened.turnId, compareId, reservedCredits: opened.reservedCredits, replay: opened.replay });
  if (opened.replay) return emit({ type: 'error', code: 'TURN_REQUEST_REPLAYED', turnId: opened.turnId });

  const close = (kind: 'completed' | 'failed' | 'interrupted' | 'erased', extra: { delivered?: boolean; refundAll?: boolean;
    failureCode?: string } = {}) => db.close({ turnId: opened.turnId, kind, delivered: extra.delivered ?? false,
    refundAll: extra.refundAll, failureCode: extra.failureCode ?? null });
  try {
    const history = (opened as { history?: Array<{ seq: number; role: 'user' | 'assistant'; content: string }> }).history ?? [];
    if (history.map(m => m.seq).join() !== sized.map(m => m.seq).join()) throw new TurnStop('TURN_INPUT_TOO_LARGE');
    let seq = 0;
    // 4. The positioning check, as a free chat: only without a confirmed positioning; never charged to the user.
    let fallback = false;
    const gate = (opened as { positioning?: { refusals24h: number } | null }).positioning;
    if (gate && !admit.positioned) {
      if (parts.skill?.socialMedia) { await close('failed', { refundAll: true, failureCode: 'positioning_required' });
        return emit({ type: 'error', code: 'POSITIONING_REQUIRED', turnId: opened.turnId }); }
      const calls = db.calls(opened.turnId, () => null);
      const begun = await calls.begin({ actorId: input.actorId, turnId: opened.turnId, seq: ++seq, callKind: 'decision',
        modelId: quotes[0]!.modelId, toolName: null, paid: null, requestHash: sha256(parts.question),
        upperUsd: decisionUpper, multiplier: quotes[0]!.multiplier });
      if (begun.sessionTombstoned || begun.accountErasing) throw new TurnStop('TURN_TOMBSTONED');
      let refused = false;
      const spent: { sent: boolean; cost: string | null } = { sent: false, cost: null };
      try { fallback = await judgePositioning(deps.gate ?? {}, { text: parts.question, apiKey: key,
        onCost: usdCost => { spent.sent = true; spent.cost = usdCost === null ? null : ceil12(usdCost.toFixed(15)); } },
        gate.refusals24h >= POSITIONING_REFUSAL_CAP); }
      catch { refused = true; }
      const usage = { chargeUser: false };
      await calls.record(spent.sent
        ? { actorId: input.actorId, turnId: opened.turnId, seq, status: 'ok', nominalUsd: spent.cost ?? decisionUpper,
          actualUsd: spent.cost, usage, providerId: null, payloadHash: sha256(refused ? 'refused' : 'allowed'), raw: null }
        : { actorId: input.actorId, turnId: opened.turnId, seq, status: 'not_sent', nominalUsd: null, actualUsd: null, usage,
          providerId: null, payloadHash: sha256(refused ? 'refused' : 'allowed'), raw: null });
      if (refused) {
        await close('failed', { refundAll: true, failureCode: 'positioning_required' });
        return emit({ type: 'error', code: 'POSITIONING_REQUIRED', turnId: opened.turnId });
      }
    }
    // 5. The columns: the request rebuilt from turn_open's history with the rule actually admitted; never above its frozen bound.
    const request = compareRequest(partsWith(history, fallback));
    // The provider's stream frames become the column's visible text; under the fallback rule the start is held until it
    // cannot be the refusal marker, and a refused column is never shown (as the BILL2 column, compareStream.columnStreamer).
    const streamers = quotes.map((_quote, index) => columnStreamer({ holdForRefusal: fallback,
      emit: text => emit({ type: 'column', index, delta: text }) }));
    const members = quotes.map((quote, index) => {
      const body = fusionRequestBody(quote.policy as never, request, quote.outputLimit, quote.reasoning);
      const call = fusionCall(quote, body);
      if (callCredits(q, call.upperUsd, call.multiplier) > credits[index]!) throw new TurnStop('TURN_INPUT_TOO_LARGE');
      return { call, body, phase: 'fusion_compare' as const,
        judge: (text: string) => ({ verdict: fallback && isPositioningRefusal(text) ? 'no_delivery' as const : 'usable' as const }),
        onChunk: streamers[index]!.onChunk };
    });
    const outcomes: MemberOutcome[] = await runGroup({ db, slots: deps.slots, actorId: input.actorId, turnId: opened.turnId,
      nextSeq: () => ++seq, credential: async () => key, transport: deps.transport, calls: deps.newWork.calls }, members);
    outcomes.forEach((outcome, index) => {
      streamers[index]!.settle(outcome.ok && outcome.verdict === 'no_delivery');
      emit({ type: 'answer', index, ok: outcome.ok && outcome.verdict === 'usable', ...(outcome.ok ? {} : { code: outcome.code }) });
    });
    // 6. Close: the columns delivered pay their own cost (each rounded); none delivered pays nothing.
    if (outcomes.some(o => !o.ok && o.code === 'TURN_TOMBSTONED')) {
      await close('erased', { failureCode: 'turn_tombstoned' });
      return emit({ type: 'error', code: 'TURN_TOMBSTONED', turnId: opened.turnId });
    }
    const delivered = outcomes.some(o => o.ok && o.verdict === 'usable');
    const unknown = outcomes.some(o => !o.ok && o.code === 'TURN_CALL_UNKNOWN');
    // Nothing delivered because the models refused under the fallback rule: a positioning refusal, counted toward the refund
    // cap (turn_fusion_open's refusals24h), as the free chat's; repeating it cannot keep using models for free.
    const refusedAll = !delivered && outcomes.some(o => o.ok && o.verdict === 'no_delivery' && !o.empty);
    if (refusedAll && !unknown) {
      await close('failed', { refundAll: true, failureCode: 'positioning_required' });
      return emit({ type: 'error', code: 'POSITIONING_REQUIRED', turnId: opened.turnId });
    }
    const closed = delivered ? await close('completed', { delivered: true })
      : await close(unknown ? 'interrupted' : 'failed', { refundAll: !unknown, failureCode: 'compare_no_answer' });
    emit({ type: 'result', turnId: opened.turnId, compareId, chargedCredits: closed.chargedCredits, settlement: closed.settlement });
  } catch (error) {
    const code = error instanceof TurnStop || error instanceof TurnDatabaseError ? error.code : 'TURN_FAILED';
    await close(code === 'TURN_TOMBSTONED' ? 'erased' : 'failed', { refundAll: code !== 'TURN_TOMBSTONED', failureCode: code.toLowerCase() })
      .catch(error => logSwallowed('compare_close_failed', error, { category: 'billing', turnId: opened.turnId }));
    emit({ type: 'error', code, turnId: opened.turnId });
  }
}
