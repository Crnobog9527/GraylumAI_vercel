/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ASK_QUESTION_TOOL, INVALID_REPLY_NOTICE } from '../../shared/agentTurn';
import { isOpeningInput } from '../../shared/opcQuestions';
import { effectiveReplyLocale } from '../../shared/replyLanguage';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { agentTurnResult } from '../runtime/agentTurnResult';
import { assertRuntimeRequestCapacity } from '../runtime/context';
import { cardSources, groundedCardFallback, groundedCardTool, groundedCardToolBytes, rejectSeparateCardProse,
  type CardSources } from '../runtime/groundedCard';
import { AGENT_TURN_REQUEST_FORMAT, openRouterRequestBody, type RequestContext } from '../runtime/providerRequest';
import { freezeSharedPromptCache } from '../runtime/promptCache';
import { replySettingInstructions } from '../runtime/replyLanguage';
import { runRuntime } from '../runtime/runner';
import { SKILL_FILE_MAX_BYTES, SKILL_FILE_TRACE_BYTES, skillFileToolBytes } from '../runtime/skillFile';
import type { PricingDeps } from '../runtime/pricingAdmission';
import { modelCall, TurnStop } from './call';
import { CLOSES, GATE_CODES, type ChatDeps } from './chat';
import { turnDatabase, TurnDatabaseError, type CloseKind, type TurnClients } from './db';
import { projectHistory, trimHistory, turnSession } from './history';
import type { CounterStore } from './limiter';
import { mentorCatalog, MentorCatalogError, mentorPolicy } from './mentorCatalog';
import { mentorHost, mentorOrganizerInput, mentorState, resourcesOf } from './mentorContext';
import { mentorSystem, mentorUserMessage, organizerInput, organizerInstructions, projectMentorHistory } from './mentorPrompt';
import { loadMentorSkill, mentorSkillFileTool, mentorSkillSource, prepareMentorFiles } from './mentorSkill';
import type { ChatQuote } from './quote';
import type { TurnEvent } from './sse';
import { logSwallowed, swallow } from '../../lib/swallow';

/*
 * CORE-PATH-V2 kind=mentor (plan 2.7, 6.1 V2-5): one turn of the positioning mentor. Database work is turn_open (which also
 * reads the draft, checklist and Skill identity: turn_mentor_context), three writes per model call and turn_close (which also
 * applies the organizer's checklist patches: turn_mentor_apply). A normal turn has at most three model calls (the reply, one
 * continuation after read_skill_file, the organizer): 1 + 9 + 1 = 11 round trips (plan 3.1). The Skill text and files come from
 * the process cache by content hash; nothing touches the database between model calls. Not in this kind yet (V2-5b): answered
 * cards, step summaries, checklist-updated events, research tools and the research shortfall card.
 */
export type MentorDeps = {
  admin: SupabaseClient; clients: TurnClients; slots: CounterStore; transport?: typeof fetch; pricing?: PricingDeps;
  /** The one-switch pause and the runtime limits: the message before the turn opens, the call limit before each paid call. */
  newWork: ChatDeps['newWork'];
};
export type MentorInput = { actorId: string; sessionId: string; requestId: string; moduleId: string; stepId: string; text: string;
  organizeAfter: boolean };

// Reserved for the read_skill_file continuation (the largest file the tool returns, its JSON wrapping and the call trace).
const SKILL_FILE_RESERVE_BYTES = SKILL_FILE_MAX_BYTES + 4096 + SKILL_FILE_TRACE_BYTES;
const MARKER_RESERVE_BYTES = 256;

const callPolicy = (q: ChatQuote) => ({ modelId: q.modelId, provider: 'openrouter', account: q.identity.account, model: q.model,
  protocol: 'openrouter-chat-v1' as const, providerLimits: q.providerLimits, upperUsd: q.upperUsd, outputLimit: q.outputLimit,
  inputLimit: q.inputLimit, automaticRetry: false, hiddenTools: false, lookupSupported: true });

export async function runMentorTurn(deps: MentorDeps, input: MentorInput, emit: (event: TurnEvent) => void): Promise<void> {
  const { admin } = deps, db = turnDatabase(deps.clients);
  const opening = isOpeningInput(input.text);
  // An opening is always organized (it may carry a mentor proposal for an agent_proposal field), as the old path did.
  const organize = opening || input.organizeAfter;
  let catalog;
  try { catalog = await mentorCatalog(admin, { moduleId: input.moduleId, organize, pricing: deps.pricing }); }
  catch (error) { return emit({ type: 'error', code: error instanceof MentorCatalogError ? error.code : 'TURN_QUOTE_UNAVAILABLE' }); }
  const { mentor, organizer } = catalog;
  // The administrator's pause and the message limit, before anything is frozen (as chat.ts).
  const admitted = await deps.newWork.message(input.actorId, Promise.resolve(catalog.settings));
  if (!admitted.ok) return emit({ type: 'error', code: GATE_CODES[admitted.reason] });
  if (Buffer.byteLength(input.text) > 8000 || Buffer.byteLength(input.text) > mentor.inputLimit)
    return emit({ type: 'error', code: 'TURN_INPUT_TOO_LARGE' });

  // 1. Open: freeze, read the draft and its checklist in the same transaction.
  const policy = mentorPolicy(catalog, { opening, stepId: input.stepId, moduleId: input.moduleId });
  let opened;
  try { opened = await db.open({ actorId: input.actorId, sessionId: input.sessionId, requestId: input.requestId, kind: 'mentor', policy }); }
  catch (error) { return emit({ type: 'error', code: error instanceof TurnDatabaseError ? error.code : 'TURN_OPEN_FAILED' }); }
  emit({ type: 'opened', turnId: opened.turnId, reservedCredits: opened.reservedCredits, replay: opened.replay });
  if (opened.replay) return emit({ type: 'error', code: 'TURN_REQUEST_REPLAYED', turnId: opened.turnId });

  let seq = 0;
  const callDeps = (q: ChatQuote) => ({ db, slots: deps.slots, actorId: input.actorId, turnId: opened.turnId, nextSeq: () => ++seq,
    adapter: openRouterAdapter({ allowAgentTools: true, credential: q.credential, transport: deps.transport }) });
  const close = (kind: CloseKind, extra: { messages?: Array<{ role: 'user' | 'assistant'; content: string }>; delivered?: boolean;
    refundAll?: boolean; failureCode?: string; kindResult?: Record<string, unknown> } = {}) =>
    db.close({ actorId: input.actorId, turnId: opened.turnId, kind, messages: extra.messages ?? [], delivered: extra.delivered ?? false,
      refundAll: extra.refundAll, failureCode: extra.failureCode ?? null, kindResult: extra.kindResult });
  let stopped: TurnStop | undefined;
  const keep = (error: unknown) => { if (error instanceof TurnStop) stopped = error; throw error; };
  // The pause and the call limits again before each paid call (the old path's call gate): nothing is written or sent.
  const callGate = async () => {
    const gate = await deps.newWork.calls(input.actorId, 1, 'bill2.v2');
    if (!gate.ok) throw new TurnStop(GATE_CODES[gate.reason]);
  };
  try {
    // 2. The draft state, the Skill text of this step (cached by content hash) and the host state of this turn.
    const state = mentorState(opened.kindContext, input.stepId);
    const ctx = state.context;
    const { source, binding } = mentorSkillSource(admin, { actorId: input.actorId, moduleId: ctx.moduleId, skillId: ctx.skillId,
      revisionId: ctx.revisionId, packageHash: ctx.packageHash });
    const skill = await loadMentorSkill(source, binding, resourcesOf(state, input.stepId), mentor.inputLimit);
    // Everything later steps may read, prepared now: no database read between model calls.
    const prepared = await prepareMentorFiles(source, binding, Boolean(organizer));
    const host = mentorHost(state, input.stepId, opening);
    const system = mentorSystem({ skillText: skill.text, skillEntryChars: skill.entryChars, brandIdentity: catalog.brandIdentity,
      mode: ctx.mode, host, skillFile: !opening, replyRule: replySettingInstructions(effectiveReplyLocale(opened.replyLanguage)) });
    const userMessage = mentorUserMessage(input.text, state.scopeMaterial, host);

    // 3. History: newest that fits what the budget leaves after the system message, the tools, the current message and the
    // continuation reserve. The three cache breakpoints (mentorPrompt.ts): SKILL.md end, system end, last plain history.
    const toolBytes = groundedCardToolBytes() + skillFileToolBytes() + (opening ? 0 : SKILL_FILE_RESERVE_BYTES);
    const left = mentor.inputLimit - Buffer.byteLength(system.instructions) - Buffer.byteLength(userMessage) - toolBytes
      - MARKER_RESERVE_BYTES - 8192;
    const history = trimHistory(projectHistory(projectMentorHistory(opened.history)), Math.max(left, 0));
    const promptCache = system.prefixChars > 0 ? freezeSharedPromptCache({ real: true, model: mentor.model,
      cacheWriteUsdPerMillion: mentor.providerLimits.cacheWriteUsdPerMillion, instructions: system.instructions,
      prefixChars: system.prefixChars, historyMarker: !opening }) : undefined;
    let sources: CardSources = cardSources(input.text, history);
    const tools = [groundedCardTool(() => sources), mentorSkillFileTool(prepared, binding)];
    const context: RequestContext = { providerRequestFormat: AGENT_TURN_REQUEST_FORMAT, tools: tools.map(t => t.name), network: 'deny',
      reasoning: mentor.reasoning, hostTurnContext: { opening }, ...(promptCache ? { promptCache } : {}),
      ...(organizer ? { attachedOrganizer: { reasoning: organizer.reasoning } } : {}) };

    // 4. The mentor's reply (and its continuation after one Skill file). A choice card ends the turn.
    let text = '', toolCalled = false, cardMessage: string | null | undefined;
    const output = await runRuntime({
      model: mentor.model, instructions: system.instructions, input: userMessage, session: turnSession(history),
      maxOutputTokens: mentor.outputLimit, maxTurns: opening ? 1 : 2, reasoning: mentor.reasoning, tools, stream: true,
      allowEmptyResult: true, firstToolCallOnly: true, stopAtToolNames: [ASK_QUESTION_TOOL],
      selectHistory: async (items, incoming) => { sources = cardSources(input.text, items); return [...items, ...incoming]; },
      onText: delta => { text += delta; if (delta) emit({ type: 'text', delta }); },
      exchange: async (_sequence, body, onChunk) => {
        text = ''; cardMessage = undefined;
        const request = openRouterRequestBody(body, { context, policy: callPolicy(mentor) as never, phase: 'ordinary', primaryDialogue: true });
        try { assertRuntimeRequestCapacity(request, mentor.inputLimit); }
        catch { stopped = new TurnStop('TURN_INPUT_TOO_LARGE'); throw stopped; }
        await callGate().catch(keep);
        return modelCall(callDeps(mentor), mentor, request, onChunk).then(response => {
          const message = JSON.parse(response)?.choices?.[0]?.message, call = message?.tool_calls?.[0];
          toolCalled = Boolean(message?.tool_calls?.length);
          if (call?.function?.name === ASK_QUESTION_TOOL) cardMessage = groundedCardFallback(call.function.arguments);
          return response;
        }, keep);
      },
    });
    const turn = rejectSeparateCardProse(text, agentTurnResult(text, output, toolCalled, text.trim() ? undefined : cardMessage));
    // Nothing to show (no prose, no card): nothing was delivered, the user pays nothing.
    if (!turn.card && turn.message === INVALID_REPLY_NOTICE) throw new TurnStop('TURN_CALL_DENIED');

    // 5. The organizer: the checklist patches of this turn, applied by turn_close. A failed organizer call never takes the
    // delivered reply back; its result is then empty (recorded as invalid_output, as the old path recorded a lost organizer).
    let organized: unknown = null, captureInput: unknown;
    if (organizer) {
      const capture = mentorOrganizerInput(state, host, input.text);
      captureInput = capture.value;
      try { organized = await runOrganizer({ catalog: organizer, context, deps: callDeps(organizer), gate: callGate,
        template: prepared.organizerTemplate, opening, input: organizerInput(capture.text, turn.body) }); }
      catch (error) {
        if (error instanceof TurnStop && error.code === 'TURN_TOMBSTONED') throw error;
        logSwallowed('turn_mentor_organizer_failed', error, { category: 'ai' });
      }
    }

    // 6. Close: settle once, save both messages, apply the checklist patches in the same transaction.
    const closed = await close('completed', { delivered: true,
      messages: [{ role: 'user', content: input.text }, { role: 'assistant', content: turn.body }],
      ...(organizer ? { kindResult: { roundId: ctx.roundId, revisionId: ctx.revisionId, versions: state.versions,
        organizerInput: captureInput, output: organized } } : {}) });
    if (closed.closeKind === 'erased') return emit({ type: 'error', code: 'TURN_TOMBSTONED', turnId: opened.turnId });
    emit({ type: 'result', turnId: opened.turnId, body: turn.body, chargedCredits: closed.chargedCredits, settlement: closed.settlement,
      ...(closed.kindResult ? { kindResult: closed.kindResult } : {}) });
  } catch (error) {
    const code = stopped ? stopped.code : error instanceof TurnStop ? error.code : error instanceof TurnDatabaseError ? error.code
      : error instanceof Error && /^TURN_[A-Z_]+$/.test(error.message) ? error.message : 'TURN_FAILED';
    if (code !== 'TURN_PAUSED_FOR_CREDITS') {
      const plan = CLOSES[code] ?? { kind: 'failed' as const, refundAll: true };
      // A close that fails here is left to recovery (the turn stays open, its freeze kept); logged, never thrown at the client.
      await swallow('turn_close_failed', close(plan.kind, { refundAll: plan.refundAll, failureCode: code.toLowerCase() }), undefined,
        { category: 'ai' });
    }
    emit({ type: 'error', code, turnId: opened.turnId });
  }
}

/** One organizer call (no tools, no history): its JSON object, or null when the reply is not one. */
async function runOrganizer(input: { catalog: ChatQuote; context: RequestContext; deps: Parameters<typeof modelCall>[0];
  gate: () => Promise<void>;
  template: string | undefined; opening: boolean; input: string }): Promise<unknown> {
  const { catalog } = input;
  const instructions = organizerInstructions(input.template, input.opening);
  const output = await runRuntime({ model: catalog.model, instructions, input: input.input, session: turnSession([]),
    maxOutputTokens: catalog.outputLimit, maxTurns: 1, reasoning: catalog.reasoning, tools: [], readSessionHistory: false,
    selectHistory: async (_items, incoming) => incoming,
    exchange: async (_sequence, body) => {
      const request = openRouterRequestBody(body, { context: input.context, policy: callPolicy(catalog) as never,
        phase: 'attached_organizer', primaryDialogue: false });
      assertRuntimeRequestCapacity(request, catalog.inputLimit);
      await input.gate();
      return modelCall(input.deps, catalog, request);
    } });
  try {
    const value: unknown = JSON.parse(output);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
