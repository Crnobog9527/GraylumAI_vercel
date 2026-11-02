/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { openRouterAdapter } from './provider/openRouterAdapter';
import { readAdmissionConfiguration } from './admission/admissionConfiguration';
import { assertRuntimeRequestCapacity } from './agent/context';
import { readAdmissionSettings } from './admission/newWorkGate';
import { AGENT_TURN_REQUEST_FORMAT, openRouterRequestBody, type RequestContext } from './provider/providerRequest';
import { readPurposeBudgets } from './settings/purposeBudgets';
import { RESEARCH_THRESHOLDS_KEY } from './research/researchAdmission';
import { runRuntime } from './agent/runner';
import { rowFor } from './settings/settingsRows';
import { swallow } from '../../lib/swallow';
import { modelCall, TurnStop } from './call';
import { CLOSES, GATE_CODES, readCoreConfig, type ChatDeps } from './chat';
import { turnDatabase, TurnDatabaseError, type CloseKind } from './db';
import { turnSession } from './history';
import { ORGANIZER_INPUT_BYTES } from './mentorCatalog';
import { startThresholdCredits, turnPolicy } from './policy';
import { chatQuote, QuoteError } from './quote';
import { SUMMARY_MODEL_SETTING } from '../artifacts/summaryPolicy';
import { parseVoiceProfile, VOICE_INSTRUCTIONS, VOICE_OUTPUT_TOKENS, voiceInput, type VoiceMaterial } from '../voice/profile';

/*
 * CORE-PATH-V2 V2-12 B7 kind=voice: "学习我的文风" (Master Plan 5.3 steps 1-3), one call on the organizer (summary) model, no tools,
 * on the account's frozen corpus. As the old path (a sessionless BILL2 run): the user pays what the call cost, and only when a usable
 * profile was saved; every other end (a refusal, a failed or unusable answer, a crash, a deleted version) pays nothing. Nothing is
 * estimated or shown beforehand. The profile is written by turn_voice_apply in the close's transaction; a version deleted meanwhile
 * is a tombstone (the next call, or the close, finds it) and the turn closes erased. The caller marks a version failed
 * (voice_generation_finish) when this returns a code; a crash before that is the daily recovery's. There is no conversation: the
 * turn has no session and no history.
 */
export type VoiceTurnInput = { actorId: string; requestId: string; versionId: string; material: VoiceMaterial[] };
export type VoiceTurnOutcome = { saved: true; turnId: number } | { saved: false; code: string; turnId?: number };

const voiceContext = z.object({ generating: z.boolean() }).passthrough();
/** The turn code of a stop as the voice page words it. */
const VOICE_CODES: Record<string, string> = {
  TURN_TOMBSTONED: 'VOICE_VERSION_GONE', TURN_NEW_CALLS_PAUSED: 'VOICE_PAUSED', TURN_RATE_LIMITED: 'VOICE_RATE_LIMITED',
  TURN_INSUFFICIENT_CREDITS: 'VOICE_INSUFFICIENT_CREDITS', TURN_PAUSED_FOR_CREDITS: 'VOICE_INSUFFICIENT_CREDITS',
  TURN_PROVIDER_402: 'VOICE_PROVIDER_REJECTED', TURN_CALL_UNKNOWN: 'VOICE_RESULT_PENDING',
};
const voiceCode = (code: string) => VOICE_CODES[code] ?? (/^VOICE_[A-Z_]+$/.test(code) ? code : 'VOICE_UNAVAILABLE');

export async function runVoiceTurn(deps: ChatDeps, input: VoiceTurnInput): Promise<VoiceTurnOutcome> {
  const { admin } = deps, db = turnDatabase(deps.clients);
  const fail = (code: string, turnId?: number): VoiceTurnOutcome => ({ saved: false, code: voiceCode(code), ...(turnId ? { turnId } : {}) });
  // 1. The catalog (cached): the switch, the organizer model and the quote of its one call, before anything is frozen.
  const configuration = readAdmissionConfiguration(admin);
  const rows = await configuration, config = readCoreConfig(rows);
  if (!config) return fail('TURN_CORE_DISABLED');
  const settings = await readAdmissionSettings(admin, configuration);
  const admitted = await deps.newWork.message(input.actorId, Promise.resolve(settings));
  if (!admitted.ok) return fail(GATE_CODES[admitted.reason]);
  const model = z.string().uuid().safeParse(rowFor(rows, SUMMARY_MODEL_SETTING).data?.value);
  if (!model.success) return fail('VOICE_MODEL_NOT_CONFIGURED');
  const instructions = VOICE_INSTRUCTIONS, current = voiceInput(input.material);
  let quote;
  try {
    const budgets = await readPurposeBudgets(admin, configuration);
    quote = await chatQuote(admin, { configuration: rows, modelId: model.data, deps: deps.pricing,
      inputBytes: budgets?.organize.inputBytes ?? ORGANIZER_INPUT_BYTES,
      use: { phase: 'attached_organizer', requestFormat: AGENT_TURN_REQUEST_FORMAT, purpose: 'organize', outputCap: VOICE_OUTPUT_TOKENS } });
  } catch (error) {
    if (error instanceof QuoteError) return fail(error.code === 'TURN_MODEL_NOT_ADMITTED' ? 'VOICE_MODEL_UNAVAILABLE' : error.code);
    return fail('TURN_QUOTE_UNAVAILABLE');
  }
  if (Buffer.byteLength(instructions) + Buffer.byteLength(current) > quote.inputLimit) return fail('TURN_INPUT_TOO_LARGE');
  const thresholds = rowFor(rows, RESEARCH_THRESHOLDS_KEY);
  const startCredits = startThresholdCredits(thresholds.error ? null : thresholds.data?.value, quote.model, 'attached_organizer', quote.q,
    quote.multiplier);
  if (startCredits === undefined) return fail('TURN_START_THRESHOLD_UNCONFIGURED');

  // 2. Open: one call, no tools, no history, no conversation. turn_voice_context says whether the version still generates.
  const policy = { ...turnPolicy({ q: quote.q, multiplier: quote.multiplier, modelUpperUsd: quote.upperUsd, startThresholdCredits: startCredits,
    limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 }, stopLoss: config.stopLoss, historyItems: 0,
    inputBytes: quote.inputLimit, pricing: quote.pricing, frozen: { modelId: quote.modelId, model: quote.model } }),
  voice: { versionId: input.versionId } };
  let opened;
  try { opened = await db.open({ actorId: input.actorId, sessionId: null, requestId: input.requestId, kind: 'voice', policy }); }
  catch (error) { return fail(error instanceof TurnDatabaseError ? error.code : 'TURN_OPEN_FAILED'); }
  // A repeated request never runs the model again; the version it made is read as it stands.
  if (opened.replay) return fail('TURN_REQUEST_REPLAYED', opened.turnId);
  const turnId = opened.turnId;
  const close = (kind: CloseKind, extra: { result?: unknown; refundAll?: boolean; failureCode?: string } = {}) =>
    db.close({ actorId: input.actorId, turnId, kind, messages: [], delivered: extra.result !== undefined, refundAll: extra.refundAll,
      failureCode: extra.failureCode ?? null, ...(extra.result === undefined ? {} : { kindResult: extra.result }) });
  const abandon = async (code: string) => {
    await swallow('turn_close_failed', close('failed', { refundAll: true, failureCode: code.toLowerCase() }), undefined, { category: 'ai' });
    return fail(code, turnId);
  };
  if (!voiceContext.safeParse(opened.kindContext).data?.generating) return abandon('VOICE_VERSION_GONE');

  // 3. The call: the organizer model on the frozen corpus; the answer is parsed by code (no second call).
  let text = '', stopped: TurnStop | undefined, seq = 0;
  try {
    const request: RequestContext = { providerRequestFormat: AGENT_TURN_REQUEST_FORMAT, tools: [], network: 'deny', reasoning: quote.reasoning };
    const callPolicy = { modelId: quote.modelId, provider: 'openrouter', account: quote.identity.account, model: quote.model,
      protocol: 'openrouter-chat-v1' as const, providerLimits: quote.providerLimits, upperUsd: quote.upperUsd, outputLimit: quote.outputLimit,
      inputLimit: quote.inputLimit, automaticRetry: false, hiddenTools: false, lookupSupported: true };
    const callDeps = { db, slots: deps.slots, actorId: input.actorId, turnId, nextSeq: () => ++seq,
      adapter: openRouterAdapter({ credential: quote.credential, transport: deps.transport }) };
    const output = await runRuntime({
      model: quote.model, instructions, input: current, session: turnSession([]),
      maxOutputTokens: quote.outputLimit, maxTurns: 1, reasoning: quote.reasoning, tools: [], stream: true, readSessionHistory: false,
      selectHistory: async (_items, incoming) => incoming,
      onText: delta => { text += delta; },
      exchange: async (_sequence, body, onChunk) => {
        const built = openRouterRequestBody(body, { context: request, policy: callPolicy as never, phase: 'ordinary', primaryDialogue: true });
        try { assertRuntimeRequestCapacity(built, quote.inputLimit); }
        catch { stopped = new TurnStop('TURN_INPUT_TOO_LARGE'); throw stopped; }
        // The pause and the call limits again before the paid call: nothing is written or sent when refused.
        const gate = await deps.newWork.calls(input.actorId, 1, 'bill2.v2');
        if (!gate.ok) { stopped = new TurnStop(GATE_CODES[gate.reason]); throw stopped; }
        return modelCall(callDeps, quote, built, onChunk).catch(error => { if (error instanceof TurnStop) stopped = error; throw error; });
      },
    });
    // 4. An answer that is no usable profile is a confirmed failure: the cost is the platform's, the user's freeze comes back.
    const profile = parseVoiceProfile(output || text, input.material);
    if (!profile) return abandon('VOICE_FORMAT_INVALID');
    const closed = await close('completed', { result: { versionId: input.versionId, profile } });
    if (closed.closeKind === 'erased') return fail('TURN_TOMBSTONED', turnId);
    return { saved: true, turnId };
  } catch (error) {
    const code = stopped ? stopped.code : error instanceof TurnStop ? error.code : error instanceof TurnDatabaseError ? error.code : 'TURN_FAILED';
    // Nothing delivered: the user pays nothing; an unknown outcome waits for recovery. A failed close is left to recovery too.
    const plan = CLOSES[code] ?? { kind: 'failed' as const, refundAll: true };
    await swallow('turn_close_failed', close(plan.kind, { refundAll: plan.refundAll, failureCode: code.toLowerCase() }), undefined,
      { category: 'ai' });
    return fail(code, turnId);
  }
}
