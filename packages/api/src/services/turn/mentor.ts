/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ASK_QUESTION_TOOL, INVALID_REPLY_NOTICE } from '../../shared/agentTurn';
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
import { skillFileToolBytes } from '../runtime/skillFile';
import type { PricingDeps } from '../runtime/pricingAdmission';
import { modelCall, TurnStop } from './call';
import { CLOSES, GATE_CODES, type ChatDeps } from './chat';
import { turnDatabase, TurnDatabaseError, type CloseKind, type TurnClients } from './db';
import { projectHistory, trimHistory, turnSession } from './history';
import type { CounterStore } from './limiter';
import { mentorCatalog, MentorCatalogError, mentorPolicy } from './mentorCatalog';
import { mentorHost, mentorOrganizerInput, mentorState, resourcesOf } from './mentorContext';
import { answeredText, mentorAnsweredCard, mentorReplyBody, mentorTurnInput, type MentorAnswer } from './mentorInput';
import { mentorSystem, mentorUserMessage, organizerInput, organizerInstructions, projectMentorHistory } from './mentorPrompt';
import { loadMentorSkill, mentorSkillFileTool, mentorSkillSource, prepareMentorFiles, skillFileReserveBytes } from './mentorSkill';
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
  organizeAfter: boolean; /** V2-5b: an answer to the card of the latest mentor reply of this step. */ answer?: MentorAnswer };

const MARKER_RESERVE_BYTES = 256;
const sourceChecked = z.object({ allowed: z.boolean(), businessContext: z.unknown().optional() });
/** Conversations whose draft needs mentor_source_check: a hint per process, never a permission (turn_open enforces it). */
const SOURCE_DRAFTS = new Set<string>(), SOURCE_DRAFTS_KEPT = 5000;

const callPolicy = (q: ChatQuote) => ({ modelId: q.modelId, provider: 'openrouter', account: q.identity.account, model: q.model,
  protocol: 'openrouter-chat-v1' as const, providerLimits: q.providerLimits, upperUsd: q.upperUsd, outputLimit: q.outputLimit,
  inputLimit: q.inputLimit, automaticRetry: false, hiddenTools: false, lookupSupported: true });

export async function runMentorTurn(deps: MentorDeps, input: MentorInput, emit: (event: TurnEvent) => void): Promise<void> {
  const { admin } = deps, db = turnDatabase(deps.clients);
  // The kind of turn: an opening, a step summary, a checklist-updated event, an answer to a card, or the user's words (V2-5b).
  let kind;
  try { kind = mentorTurnInput(input); } catch { return emit({ type: 'error', code: 'TURN_REQUEST_INVALID' }); }
  const { opening, summary, organize } = kind;
  let catalog;
  try { catalog = await mentorCatalog(admin, { moduleId: input.moduleId, organize, pricing: deps.pricing }); }
  catch (error) { return emit({ type: 'error', code: error instanceof MentorCatalogError ? error.code : 'TURN_QUOTE_UNAVAILABLE' }); }
  const { mentor, organizer } = catalog;
  // The administrator's pause and the message limit, before anything is frozen (as chat.ts).
  const admitted = await deps.newWork.message(input.actorId, Promise.resolve(catalog.settings));
  if (!admitted.ok) return emit({ type: 'error', code: GATE_CODES[admitted.reason] });
  // The product limit is 8000 characters (as the old mentor request); the model's input budget is in bytes, checked apart.
  if (input.text.length > 8000 || Buffer.byteLength(input.text) > mentor.inputLimit)
    return emit({ type: 'error', code: 'TURN_INPUT_TOO_LARGE' });

  // 1. The whole source and evidence chain, for a draft that has one, before anything is frozen; refused here, nothing was charged.
  // turn_open refuses such a draft unless this ran, so the hint only saves that first refused open.
  const sourceCheck = async () => {
    const { data, error } = await deps.clients.read.rpc('mentor_source_check', { p_actor_id: input.actorId, p_session_id: input.sessionId });
    if (error) throw new Error('TURN_OPEN_FAILED');
    return sourceChecked.parse(data);
  };
  let checked: z.infer<typeof sourceChecked> | undefined;
  // 2. Open: freeze, read the draft and its checklist in the same transaction.
  const openTurn = () => db.open({ actorId: input.actorId, sessionId: input.sessionId, requestId: input.requestId, kind: 'mentor',
    policy: mentorPolicy(catalog, { opening, stepId: input.stepId, moduleId: input.moduleId, sourceChecked: checked !== undefined }) });
  let opened;
  try {
    if (SOURCE_DRAFTS.has(input.sessionId)) checked = await sourceCheck();
    if (checked?.allowed === false) return emit({ type: 'error', code: 'TURN_MENTOR_DENIED' });
    try { opened = await openTurn(); }
    catch (error) {
      if (!(error instanceof TurnDatabaseError) || error.code !== 'TURN_SOURCE_CHECK_REQUIRED' || checked) throw error;
      if (SOURCE_DRAFTS.size >= SOURCE_DRAFTS_KEPT) SOURCE_DRAFTS.clear();
      SOURCE_DRAFTS.add(input.sessionId);
      checked = await sourceCheck();
      if (!checked.allowed) return emit({ type: 'error', code: 'TURN_MENTOR_DENIED' });
      opened = await openTurn();
    }
  } catch (error) { return emit({ type: 'error', code: error instanceof TurnDatabaseError ? error.code : 'TURN_OPEN_FAILED' }); }
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
    // 3. The draft state, the Skill text of this step (cached by content hash) and the host state of this turn.
    const state = mentorState(opened.kindContext, input.stepId);
    const ctx = state.context;
    if (checked?.businessContext) (ctx.work as Record<string, unknown>).businessContext = checked.businessContext;
    const { source, binding } = mentorSkillSource(admin, { actorId: input.actorId, moduleId: ctx.moduleId, skillId: ctx.skillId,
      revisionId: ctx.revisionId, packageHash: ctx.packageHash });
    const skill = await loadMentorSkill(source, binding, resourcesOf(state, input.stepId), mentor.inputLimit);
    // Everything later steps may read, prepared now: no database read between model calls.
    const prepared = await prepareMentorFiles(source, binding, Boolean(organizer));
    const answered = input.answer ? mentorAnsweredCard(opened.history, input.stepId, input.answer, opened.turnId) : undefined;
    // The user's words of this turn: a chosen option's text replaces the input, as the old path did.
    const words = answeredText(input.text, answered);
    const host = mentorHost(state, input.stepId, { opening, summary, updatedFieldIds: kind.updatedFieldIds });
    const system = mentorSystem({ skillText: skill.text, skillEntryChars: skill.entryChars, brandIdentity: catalog.brandIdentity,
      mode: ctx.mode, host, skillFile: !opening, summary,
      replyRule: replySettingInstructions(effectiveReplyLocale(opened.replyLanguage)) });
    const userMessage = mentorUserMessage(words, state.scopeMaterial, host);

    // 4. History: newest that fits what the budget leaves after the system message, the tools, the current message and the
    // continuation reserve. The three cache breakpoints (mentorPrompt.ts): SKILL.md end, system end, last plain history.
    // The continuation reserve: the largest prepared file as the tool result is embedded in the request (twice JSON-escaped).
    const toolBytes = (summary ? 0 : groundedCardToolBytes()) + skillFileToolBytes() + (opening ? 0 : skillFileReserveBytes(prepared, binding));
    const left = mentor.inputLimit - Buffer.byteLength(system.instructions) - Buffer.byteLength(userMessage) - toolBytes
      - MARKER_RESERVE_BYTES - 8192;
    const history = trimHistory(projectHistory(projectMentorHistory(opened.history)), Math.max(left, 0));
    const promptCache = system.prefixChars > 0 ? freezeSharedPromptCache({ real: true, model: mentor.model,
      cacheWriteUsdPerMillion: mentor.providerLimits.cacheWriteUsdPerMillion, instructions: system.instructions,
      prefixChars: system.prefixChars, historyMarker: !opening }) : undefined;
    let sources: CardSources = cardSources(words, history);
    // A step summary is offered no question card (as the old path's admission removed it), not only told not to show one.
    const tools = [...(summary ? [] : [groundedCardTool(() => sources)]), mentorSkillFileTool(prepared, binding)];
    const context: RequestContext = { providerRequestFormat: AGENT_TURN_REQUEST_FORMAT, tools: tools.map(t => t.name), network: 'deny',
      reasoning: mentor.reasoning, hostTurnContext: { opening }, ...(promptCache ? { promptCache } : {}),
      ...(organizer ? { attachedOrganizer: { reasoning: organizer.reasoning } } : {}) };

    // 5. The mentor's reply (and its continuation after one Skill file). A choice card ends the turn.
    let text = '', toolCalled = false, cardMessage: string | null | undefined;
    const output = await runRuntime({
      model: mentor.model, instructions: system.instructions, input: userMessage, session: turnSession(history),
      maxOutputTokens: mentor.outputLimit, maxTurns: opening ? 1 : 2, reasoning: mentor.reasoning, tools, stream: true,
      allowEmptyResult: true, firstToolCallOnly: true, stopAtToolNames: [ASK_QUESTION_TOOL],
      selectHistory: async (items, incoming) => { sources = cardSources(words, items); return [...items, ...incoming]; },
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

    // 6. The organizer: the checklist patches of this turn, applied by turn_close. A failed organizer call never takes the
    // delivered reply back; its result is then empty (recorded as invalid_output, as the old path recorded a lost organizer).
    let organized: unknown = null, captureInput: unknown;
    if (organizer) {
      const capture = mentorOrganizerInput(state, host, words, answered);
      captureInput = capture.value;
      try { organized = await runOrganizer({ catalog: organizer, context, deps: callDeps(organizer), gate: callGate,
        template: prepared.organizerTemplate, opening, input: organizerInput(capture.text, turn.body) }); }
      catch (error) {
        // A deletion ends the turn; a credit pause keeps it waiting (not closed, so a resume can still organize this reply).
        if (error instanceof TurnStop && (error.code === 'TURN_TOMBSTONED' || error.code === 'TURN_PAUSED_FOR_CREDITS')) throw error;
        logSwallowed('turn_mentor_organizer_failed', error, { category: 'ai' });
      }
    }

    // 7. Close: settle once, save both messages, apply the checklist patches in the same transaction. A source withdrawn during
    // this turn keeps the reply but writes nothing to the checklist (the check turn_close made on the old chain); a failed read
    // counts as withdrawn.
    const scopeDenied = Boolean(organizer && checked && !(await sourceCheck().catch(() => ({ allowed: false }))).allowed);
    const closed = await close('completed', { delivered: true,
      messages: [{ role: 'user', content: words }, { role: 'assistant', content: mentorReplyBody(turn.body, input.stepId) }],
      ...(organizer ? { kindResult: { roundId: ctx.roundId, revisionId: ctx.revisionId, versions: state.versions,
        organizerInput: captureInput, output: organized, ...(scopeDenied ? { scopeDenied } : {}) } } : {}) });
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
  // The SDK wraps what the exchange throws; the turn's own stop (a pause, a deletion) is kept and rethrown as itself.
  let stopped: TurnStop | undefined;
  const keep = (error: unknown) => { if (error instanceof TurnStop) stopped = error; throw error; };
  const output = await runRuntime({ model: catalog.model, instructions, input: input.input, session: turnSession([]),
    maxOutputTokens: catalog.outputLimit, maxTurns: 1, reasoning: catalog.reasoning, tools: [], readSessionHistory: false,
    selectHistory: async (_items, incoming) => incoming,
    exchange: async (_sequence, body) => {
      const request = openRouterRequestBody(body, { context: input.context, policy: callPolicy(catalog) as never,
        phase: 'attached_organizer', primaryDialogue: false });
      assertRuntimeRequestCapacity(request, catalog.inputLimit);
      await input.gate().catch(keep);
      return modelCall(input.deps, catalog, request).catch(keep);
    } }).catch(error => { throw stopped ?? error; });
  try {
    const value: unknown = JSON.parse(output);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
