/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AgentInputItem } from '@openai/agents';
import { effectiveReplyLocale } from '../../shared/replyLanguage';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { withBrandIdentity } from '../modelIdentity/brandIdentity';
import { readAdmissionConfiguration, type ConfigurationRows } from '../runtime/admissionConfiguration';
import { RESEARCH_THRESHOLDS_KEY } from '../runtime/researchAdmission';
import { rowFor } from '../runtime/settingsRows';
import { CORE_PATH_SETTING } from './settingKeys';
import { readAdmissionSettings, type NewWorkGateResult, type RuntimeCallGate, type SettingsRead } from '../runtime/newWorkGate';
import { DECISIONS_MODEL, judgePositioning, POSITIONING_REFUSAL_CAP, type PositioningGatePolicy } from '../runtime/positioningGate';
import { freeChatInstructions } from '../runtime/primaryInstructions';
import { assertRuntimeRequestCapacity } from '../runtime/context';
import { isPositioningRefusal, POSITIONING_FALLBACK_INSTRUCTIONS, POSITIONING_MARKER } from '../runtime/positioningFallback';
import { FREE_CHAT_REQUEST_FORMAT, openRouterRequestBody, PLAIN_TEXT_STREAM, type RequestContext } from '../runtime/providerRequest';
import { freezeSharedPromptCache } from '../runtime/promptCache';
import { readPurposeBudgets } from '../runtime/purposeBudgets';
import { replySettingInstructions } from '../runtime/replyLanguage';
import { runRuntime } from '../runtime/runner';
import { serverChatModel } from '../runtime/serverChatModel';
import type { PricingDeps } from '../runtime/pricingAdmission';
import { ceil12, modelCall, TurnStop } from './call';
import { turnDatabase, TurnDatabaseError, type CloseKind, type TurnClients } from './db';
import { projectHistory, trimHistory, turnSession } from './history';
import type { CounterStore } from './limiter';
import { startThresholdCredits, stopLossSettings, turnPolicy } from './policy';
import { chatQuote, QuoteError } from './quote';
import type { TurnEvent } from './sse';
import { swallow } from '../../lib/swallow';
import { resumeLimits, TurnReplay, type ResumeRead } from './resume';
import { prepareChatTools, type ChatSelection, type ChatToolDeps, type ChatToolsSetup } from './tools/chatTools';
import { RESEARCH_INPUT_BYTES } from './tools/plan';
import { fitToolTurn } from './tools/capacity';

/*
 * CORE-PATH-V2 kind=chat (2.7): a free-chat turn without tools (V2-4a; the free tools come in V2-4b). Database work is
 * turn_open, the three writes of each call and turn_close: five round trips for one model call. Everything slow-changing
 * comes from the catalog cache (settings, model row, price snapshot); the prompt is a site-wide segment and a per-user segment,
 * each with a cache breakpoint (2.9 rule 3), then the history, then the current message.
 */
export { CORE_PATH_SETTING } from './settingKeys';
// decisionUpperUsd: the most one positioning check (Decisions) can cost the platform; it is reserved on the stop-loss (Fable 10-28).
export const coreSetting = z.object({ enabled: z.boolean(), stopLoss: stopLossSettings,
  decisionUpperUsd: z.string().regex(/^0\.\d{1,12}$/) }).strict();
export const HISTORY_ITEMS = 100;
/** The core-path switch and stop-loss parameters from the admission configuration rows, or null when off or not valid. */
export function readCoreConfig(configuration: ConfigurationRows) {
  const core = rowFor(configuration, CORE_PATH_SETTING);
  const config = coreSetting.safeParse(core.error ? null : core.data?.value);
  return config.success && config.data.enabled ? config.data : null;
}
/** The route's maxDuration (300 s): supplier requests stop in time for the reply (V2-6). */
const TURN_BUDGET_MS = 300_000;

export type ChatDeps = {
  admin: SupabaseClient; clients: TurnClients; slots: CounterStore;
  /** The runtime rate limits and the one-switch pause (runtime/newWorkGate.ts), checked before the turn opens (message) and
   *  before each model call (calls), as the old path does (CORE-PATH-V2 4.1). */
  newWork: { message: (actorId: string, read: Promise<SettingsRead>) => Promise<NewWorkGateResult>; calls: RuntimeCallGate };
  /** OpenRouter transport (tests and the load-test stub); production uses fetch. */
  transport?: typeof fetch; pricing?: PricingDeps; gate?: PositioningGatePolicy;
  /** V2-6: the tools a free chat offers; absent, the turn has none (V2-4a). */
  tools?: ChatToolDeps;
};
export type ChatInput = { actorId: string; sessionId: string; requestId: string; text: string; chosen?: ChatSelection;
  /** The turn paused for credits this one continues, as read before it (resume.ts). */ resume?: { of: number; read: ResumeRead } };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const CLOSES: Record<string, { kind: CloseKind; refundAll: boolean }> = {
  TURN_TOMBSTONED: { kind: 'erased', refundAll: false },
  TURN_CALL_UNKNOWN: { kind: 'interrupted', refundAll: false },
  TURN_PROVIDER_402: { kind: 'failed', refundAll: true },
  TURN_CALL_DENIED: { kind: 'failed', refundAll: true },
  TURN_PROVIDER_BUSY: { kind: 'failed', refundAll: true },
  TURN_PROVIDER_LIMIT_UNAVAILABLE: { kind: 'failed', refundAll: true },
  TURN_INPUT_TOO_LARGE: { kind: 'failed', refundAll: true },
  TURN_NEW_CALLS_PAUSED: { kind: 'failed', refundAll: true },
  TURN_RATE_LIMITED: { kind: 'failed', refundAll: true },
  TURN_LIMIT_UNAVAILABLE: { kind: 'failed', refundAll: true },
  TURN_USAGE_CONFIGURATION_REQUIRED: { kind: 'failed', refundAll: true },
};
/** A refusal of the new-work gate as a turn code: the administrator's pause, a minute or day limit, or limits unavailable. */
export const GATE_CODES = { paused: 'TURN_NEW_CALLS_PAUSED', call_limited: 'TURN_RATE_LIMITED', limit_unavailable: 'TURN_LIMIT_UNAVAILABLE',
  usage_configuration_required: 'TURN_USAGE_CONFIGURATION_REQUIRED' } as const;

export async function runChatTurn(deps: ChatDeps, input: ChatInput, emit: (event: TurnEvent) => void): Promise<void> {
  const { admin } = deps, db = turnDatabase(deps.clients), started = Date.now();
  // 1. The catalog (cached): switch and stop-loss, model, input budget, identity guard, the quote of one call.
  const configuration = readAdmissionConfiguration(admin);
  const config = readCoreConfig(await configuration);
  if (!config) return emit({ type: 'error', code: 'TURN_CORE_DISABLED' });
  const settings = await readAdmissionSettings(admin, configuration);
  // The one-switch pause and the message limits, before anything is frozen (the old path's admission check).
  const admitted = await deps.newWork.message(input.actorId, Promise.resolve(settings));
  if (!admitted.ok) return emit({ type: 'error', code: GATE_CODES[admitted.reason] });
  // Before each paid call (model, or a research tool for its subcalls): the one-switch pause and the call limits; a refusal
  // stops the turn before anything is written or sent.
  const callGate = async (count: number) => {
    const gate = await deps.newWork.calls(input.actorId, count, 'bill2.v2');
    if (!gate.ok) { stopped = new TurnStop(GATE_CODES[gate.reason]); throw stopped; }
  };
  const budgets = await readPurposeBudgets(admin, configuration);
  const interactiveBytes = budgets?.interactive.inputBytes ?? 90000;
  let quote;
  try {
    // With tools the quote allows the research ceiling; the turn narrows it again unless research is usable (V2-6).
    quote = await chatQuote(admin, { configuration: await configuration, modelId: serverChatModel(settings),
      inputBytes: deps.tools ? Math.max(interactiveBytes, RESEARCH_INPUT_BYTES) : interactiveBytes, deps: deps.pricing });
  } catch (error) {
    // A known refusal code (quote, reasoning, price snapshot) is passed on; anything else stays generic.
    const message = error instanceof Error ? error.message : '';
    return emit({ type: 'error', code: error instanceof QuoteError ? error.code : /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message
      : 'TURN_QUOTE_UNAVAILABLE' });
  }

  // The current message with the smallest instructions must fit the input budget, or nothing opens (the request bytes are
  // checked again before sending, with everything in them).
  const guard = settings.ok ? settings.identityGuard ?? true : true;
  const requiredBytes = Buffer.byteLength(input.text) + Buffer.byteLength(withBrandIdentity(freeChatInstructions(false), guard));
  // With tools the research ceiling may hold the message; it is checked again below against what the plan allows.
  if (requiredBytes > (deps.tools ? quote.inputLimit : Math.min(quote.inputLimit, interactiveBytes)))
    return emit({ type: 'error', code: 'TURN_INPUT_TOO_LARGE' });
  // V2-6: what this turn's tools may do, from the catalog cache, before anything opens (limits and bounds go into the freeze).
  let tools: ChatToolsSetup | null = null;
  if (deps.tools) {
    try {
      tools = await prepareChatTools({ admin, read: deps.clients.read, configuration, tools: deps.tools, actorId: input.actorId,
        sessionId: input.sessionId, ...(input.chosen ? { chosen: input.chosen } : {}),
        requiredBytes, interactiveBytes, quotedBytes: quote.inputLimit, modelMultiplier: quote.multiplier,
        defaultMultiplier: quote.defaultMultiplier, maxTools: quote.maxTools });
    } catch { return emit({ type: 'error', code: 'TURN_TOOLS_UNAVAILABLE' }); }
  }
  // What the user chose for this message (V2-10): refused before anything opens, never dropped silently.
  const chosen = input.chosen ? tools?.selection(input.chosen) ?? { refused: 'TURN_SKILL_UNAVAILABLE' } : { note: '' };
  if ('refused' in chosen) return emit({ type: 'error', code: chosen.refused });
  const inputLimit = tools ? tools.inputLimit : quote.inputLimit;
  // The ceiling this turn really has (research usable: the research one; otherwise the interactive one), before anything opens.
  if (tools && requiredBytes + tools.definitionBytes > inputLimit) return emit({ type: 'error', code: 'TURN_INPUT_TOO_LARGE' });
  const toolLimits = tools ? tools.plan.limits : { paidTools: 0, freeTools: 0 };

  // 2. Open: one model call per tool return plus one (2.5.3), the paid tools' bounds, and the possible positioning check,
  // outside M and the freeze.
  const decisionUpperUsd = config.decisionUpperUsd;
  // The start threshold L of this model for a free chat (purpose ordinary), from the admission configuration rows.
  const thresholds = rowFor(await configuration, RESEARCH_THRESHOLDS_KEY);
  const startCredits = startThresholdCredits(thresholds.error ? null : thresholds.data?.value, quote.model, 'ordinary', quote.q,
    quote.multiplier);
  if (startCredits === undefined) return emit({ type: 'error', code: 'TURN_START_THRESHOLD_UNCONFIGURED' });
  // A resume keeps to what the paused turn has left and replays its receipts.
  const resume = input.resume?.read;
  const limits = { model: 1 + toolLimits.paidTools + toolLimits.freeTools, ...toolLimits, decisions: 1 };
  const replay = resume ? new TurnReplay(resume.calls) : undefined;
  const frozenLimits = resume ? resumeLimits(limits, resume.limits, 0, replay?.replayedModels) : limits;
  const policy = turnPolicy({ q: quote.q, multiplier: quote.multiplier, modelUpperUsd: quote.upperUsd,
    ...(frozenLimits.decisions ? { decisionUpperUsd } : {}),
    startThresholdCredits: startCredits,
    limits: frozenLimits, paidToolUpperUsd: (tools?.plan.paidToolUpperUsd ?? []).slice(0, frozenLimits.paidTools), stopLoss: config.stopLoss,
    historyItems: HISTORY_ITEMS, inputBytes: inputLimit, pricing: quote.pricing,
    frozen: { modelId: quote.modelId, model: quote.model, ...(tools?.voiceVersionId ? { voiceVersionId: tools.voiceVersionId } : {}) } });
  let opened;
  try { opened = await db.open({ actorId: input.actorId, sessionId: input.sessionId, requestId: input.requestId, kind: 'chat', policy,
    ...(input.resume ? { resumeOf: input.resume.of } : {}) }); }
  catch (error) { return emit({ type: 'error', code: error instanceof TurnDatabaseError ? error.code : 'TURN_OPEN_FAILED' }); }
  emit({ type: 'opened', turnId: opened.turnId, reservedCredits: opened.reservedCredits, replay: opened.replay,
    ...(tools ? { tools: { available: tools.plan.available, trimmed: tools.plan.trimmed } } : {}) });
  // A repeated request never runs the model again; the first request owns the turn.
  if (opened.replay) return emit({ type: 'error', code: 'TURN_REQUEST_REPLAYED', turnId: opened.turnId });

  let seq = 0;
  const callDeps = { db, slots: deps.slots, actorId: input.actorId, turnId: opened.turnId, nextSeq: () => ++seq,
    // allowWorkspaceRead: the free-chat request shape, which may carry a history cache marker (PROMPT-CACHE-ALL).
    adapter: openRouterAdapter({ allowWorkspaceRead: true, credential: quote.credential, transport: deps.transport }) };
  const close = (kind: CloseKind, extra: { messages?: Array<{ role: 'user' | 'assistant'; content: string }>; delivered?: boolean;
    refundAll?: boolean; failureCode?: string } = {}) =>
    db.close({ actorId: input.actorId, turnId: opened.turnId, kind, messages: extra.messages ?? [], delivered: extra.delivered ?? false,
      refundAll: extra.refundAll, failureCode: extra.failureCode ?? null });
  // The model SDK wraps what the exchange throws; the stop that ended the call is kept here and wins over the wrapper.
  let stopped: TurnStop | undefined;
  try {
    // 3. Positioning gate (2.7): only when the account has no confirmed positioning. A call row the user is never charged for
    // (charge_user=false); the platform's cost is its real one, or the upper bound when the response reported none.
    let fallback = false;
    const gate = opened.positioning;
    // A resume asked this already: it continues under the fallback rule, which holds back a refusal either way.
    if (gate && !gate.positioned && resume) fallback = true;
    else if (gate && !gate.positioned) {
      const decision = await db.begin({ actorId: input.actorId, turnId: opened.turnId, seq: ++seq, callKind: 'decision',
        modelId: quote.modelId, toolName: null, paid: null, requestHash: sha256(input.text), upperUsd: decisionUpperUsd,
        multiplier: quote.multiplier });
      if (decision.sessionTombstoned || decision.accountErasing) {
        await db.record({ actorId: input.actorId, turnId: opened.turnId, seq, status: 'not_sent', nominalUsd: null, actualUsd: null,
          usage: { chargeUser: false, model: DECISIONS_MODEL }, providerId: null, payloadHash: sha256('tombstoned'), raw: null });
        throw new TurnStop('TURN_TOMBSTONED');
      }
      let refused = false;
      const spent: { sent: boolean; cost: string | null } = { sent: false, cost: null };
      const onCost = (usd: number | null) => { spent.sent = true; spent.cost = usd === null ? null : ceil12(usd.toFixed(15)); };
      try { fallback = await judgePositioning(deps.gate ?? {}, { text: input.text, apiKey: await quote.credential(), onCost },
        gate.refusals24h >= POSITIONING_REFUSAL_CAP); }
      catch { refused = true; }
      const usage = { chargeUser: false, model: DECISIONS_MODEL };
      await db.record(spent.sent
        ? { actorId: input.actorId, turnId: opened.turnId, seq, status: 'ok', nominalUsd: spent.cost ?? decisionUpperUsd,
          actualUsd: spent.cost,
          usage, providerId: null, payloadHash: sha256(refused ? 'refused' : 'allowed'), raw: null }
        : { actorId: input.actorId, turnId: opened.turnId, seq, status: 'not_sent', nominalUsd: null, actualUsd: null,
          usage, providerId: null, payloadHash: sha256(refused ? 'refused' : 'allowed'), raw: null });
      if (refused) {
        await close('failed', { refundAll: true, failureCode: 'positioning_required' });
        return emit({ type: 'error', code: 'POSITIONING_REQUIRED', turnId: opened.turnId });
      }
    }

    // 4. The prompt: site-wide segment (brand, free-chat rules) then the per-user segment (reply language and, for an account
    // without a confirmed positioning, the primary model's fallback rule: "Decisions 先判断，主模型兜底"), both cached. The
    // positioning-page redirect is only for an account that has a positioning (as admission.ts).
    const gated = Boolean(gate && !gate.positioned);
    const shared = withBrandIdentity(freeChatInstructions(!gated), guard) + (tools?.sharedInstructions(gated) ?? '');
    const instructions = shared + '\n' + replySettingInstructions(effectiveReplyLocale(opened.replyLanguage))
      + (fallback ? POSITIONING_FALLBACK_INSTRUCTIONS : '') + (tools?.userInstructions ?? '');
    const promptCache = freezeSharedPromptCache({ real: true, model: quote.model, cacheWriteUsdPerMillion:
      quote.providerLimits.cacheWriteUsdPerMillion, instructions, prefixChars: shared.length, historyMarker: true });
    const context: RequestContext = { providerRequestFormat: FREE_CHAT_REQUEST_FORMAT, textStream: PLAIN_TEXT_STREAM, tools: [],
      ...tools?.context, network: 'deny',
      reasoning: quote.reasoning, ...(promptCache ? { promptCache } : {}) };
    const callPolicy = { modelId: quote.modelId, provider: 'openrouter', account: quote.identity.account, model: quote.model,
      protocol: 'openrouter-chat-v1' as const, providerLimits: quote.providerLimits, upperUsd: quote.upperUsd, outputLimit: quote.outputLimit,
      inputLimit, automaticRetry: false, hiddenTools: false, lookupSupported: true };
    // 5. History: newest that fits what the input budget leaves after the instructions and the current message.
    // The tool definitions and the room kept for tool results are part of what the history may not take (V2-6).
    const current = input.text + chosen.note + (tools?.plan.note ?? '');
    const left = inputLimit - Buffer.byteLength(instructions) - Buffer.byteLength(current) - 8192
      - (tools ? tools.plan.reserveBytes + tools.definitionBytes : 0);
    const history = trimHistory(projectHistory(opened.history), Math.max(left, 0));
    // The reply streams. Under the fallback rule nothing is sent while the text so far could still be the refusal marker, which
    // is never shown (#900); once it cannot be, the held text goes out and the rest streams.
    let text = '', sentChars = 0, holding = fallback;
    const built = tools ? await tools.build({ db, actorId: input.actorId, turnId: opened.turnId, nextSeq: () => ++seq },
      { slots: deps.slots, currentMessage: input.text, deadline: started + TURN_BUDGET_MS,
        callGate, onStop: stop => { stopped ??= stop; }, gated, onCall: { emit, q: quote.q }, ...(replay ? { replay } : {}) }) : null;
    const output = await runRuntime({
      model: quote.model, instructions, input: current, session: turnSession(history),
      maxOutputTokens: quote.outputLimit, maxTurns: 1 + (built?.maxToolCalls ?? 0), reasoning: quote.reasoning,
      tools: built?.tools ?? [], stream: true,
      // One call per response, and no tool on the request after the last allowed call (runner.ts, 2.5.3).
      ...(built?.tools.length ? { firstToolCallOnly: true, research: { freeChat: 'core-path-v2' }, maxToolCalls: built.maxToolCalls } : {}),
      // Each tool return adds to the next request: the oldest history goes first, so the turn keeps fitting (V2-6).
      ...(built?.tools.length && tools ? { filterModelInput: (items: AgentInputItem[], text: string) =>
        fitToolTurn(items, text, history.length, inputLimit - 8192 - tools!.definitionBytes) } : {}),
      // The history was trimmed above; the SDK appends what this returns to nothing else, so the current message goes last.
      selectHistory: async (items, incoming) => [...items, ...incoming],
      onText: delta => {
        text += delta;
        if (holding) {
          const start = text.trimStart();
          if (POSITIONING_MARKER.startsWith(start) || start.startsWith(POSITIONING_MARKER)) return;
          holding = false;
        }
        if (text.length > sentChars) { emit({ type: 'text', delta: text.slice(sentChars) }); sentChars = text.length; }
      },
      exchange: async (_sequence, body, onChunk) => {
        const request = openRouterRequestBody(body, { context, policy: callPolicy as never, phase: 'ordinary', primaryDialogue: true });
        try { assertRuntimeRequestCapacity(request, inputLimit); }
        catch { stopped = new TurnStop('TURN_INPUT_TOO_LARGE'); throw stopped; }
        const stored = replay?.model();
        if (stored) return stored;
        // The pause and the call limits again before each paid call (the old path's call gate): nothing is written or sent.
        await callGate(1);
        return modelCall(callDeps, quote, request, onChunk)
          .catch(error => { if (error instanceof TurnStop) stopped = error; throw error; });
      },
    });
    const reply = output || text;
    // The fallback refusal: never shown or saved; Graylum bears the model cost (the stop-loss still counts it).
    if (fallback && isPositioningRefusal(reply)) {
      await close('failed', { refundAll: true, failureCode: 'positioning_required' });
      return emit({ type: 'error', code: 'POSITIONING_REQUIRED', turnId: opened.turnId });
    }
    // 6. Close: settle once, save both messages. A tombstone found here closes as erased and saves nothing.
    const closed = await close('completed', { delivered: true,
      messages: [{ role: 'user', content: input.text }, { role: 'assistant', content: reply }] });
    if (closed.closeKind === 'erased') return emit({ type: 'error', code: 'TURN_TOMBSTONED', turnId: opened.turnId });
    emit({ type: 'result', turnId: opened.turnId, body: reply, chargedCredits: closed.chargedCredits, settlement: closed.settlement });
  } catch (error) {
    const code = stopped ? stopped.code : error instanceof TurnStop ? error.code : error instanceof TurnDatabaseError ? error.code : 'TURN_FAILED';
    // Paused for credits: the turn waits (recovery or a resume closes it); everything else closes now.
    // The resume needs nothing from the browser. A save that fails leaves it to expire: runResumedTurn refunds it.
    if (code === 'TURN_PAUSED_FOR_CREDITS') await swallow('turn_pause_save_failed', db.pauseSave({ actorId: input.actorId,
      turnId: opened.turnId, input: { kind: 'chat', text: input.text, ...(input.chosen ? { chosen: input.chosen } : {}) } }), false, { category: 'ai' });
    if (code !== 'TURN_PAUSED_FOR_CREDITS') {
      // Any other failure delivered nothing (no answer shown as final, nothing saved): the user pays nothing; the receipts and
      // the platform's cost stay recorded (e.g. a response truncated before any text, RUNTIME_OUTPUT_TRUNCATED).
      const plan = CLOSES[code] ?? { kind: 'failed' as const, refundAll: true };
      // A close that fails here is left to recovery (the turn stays open, its freeze kept); logged, never thrown at the client.
      await swallow('turn_close_failed', close(plan.kind, { refundAll: plan.refundAll, failureCode: code.toLowerCase() }), undefined,
        { category: 'ai' });
    }
    emit({ type: 'error', code, turnId: opened.turnId });
  }
}
