/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { effectiveReplyLocale } from '../../shared/replyLanguage';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { withBrandIdentity } from '../modelIdentity/brandIdentity';
import { TOPIC_WORKSPACE_INSTRUCTION } from '../opc/topicInstructions';
import { readAdmissionConfiguration, readAdmissionModule } from '../runtime/admissionConfiguration';
import { assertRuntimeRequestCapacity, runtimeScopeInput } from '../runtime/context';
import { readAdmissionSettings } from '../runtime/newWorkGate';
import { freezeSharedPromptCache } from '../runtime/promptCache';
import { AGENT_TURN_REQUEST_FORMAT, openRouterRequestBody, type RequestContext } from '../runtime/providerRequest';
import { readPurposeBudgets } from '../runtime/purposeBudgets';
import { replySettingInstructions } from '../runtime/replyLanguage';
import { RESEARCH_THRESHOLDS_KEY } from '../runtime/researchAdmission';
import { runRuntime } from '../runtime/runner';
import { rowFor } from '../runtime/settingsRows';
import { swallow } from '../../lib/swallow';
import { modelCall, TurnStop } from './call';
import { CLOSES, GATE_CODES, HISTORY_ITEMS, readCoreConfig, type ChatDeps } from './chat';
import { turnDatabase, TurnDatabaseError, type CloseKind } from './db';
import { projectHistory, trimHistory, turnSession } from './history';
import { startThresholdCredits, turnPolicy } from './policy';
import { chatQuote, QuoteError } from './quote';
import { reportSkillText } from './reportSkill';
import type { TurnEvent } from './sse';

/*
 * CORE-PATH-V2 V2-10b: a topic turn is kind=chat in the workspace's conversation, one model call without tools, as the old
 * prepareTopicTurn: the module's model and the Skill's plan resources, metered by usage, no membership gate; the ordinary start
 * threshold (controller 11-01). The saved reply is the source of the topic draft and the adoption, named by this turn's request id.
 * Round trips: one read (topic_turn_source: writable, bound workspace, allowed source, frozen material, on the read client) plus five
 * (turn_open, the call's three writes, turn_close). The read and the open are not one transaction, and turn_open does not repeat these
 * checks for a chat: a source revoked or a business archived in between (milliseconds) still yields one reply the user pays for, which
 * cannot be repeated to Graylum's loss (AGENTS 5), and saving it from there is refused by opc_topic_original.
 */
export type TopicInput = { actorId: string; draftId: string; requestId: string; text: string };

const MAX_INPUT_BYTES = 90000;
const CODE = /\b(OPC_[A-Z_]+|CONTENT_ERASED)\b/;
const source = z.object({ sessionId: z.string().uuid(), moduleId: z.string().uuid(), skillId: z.string().uuid(),
  revisionId: z.string().uuid(), packageHash: z.string(), resources: z.array(z.string()).min(1), material: z.unknown() }).passthrough();

export async function runTopicTurn(deps: ChatDeps, input: TopicInput, emit: (event: TurnEvent) => void): Promise<void> {
  const { admin } = deps, db = turnDatabase(deps.clients);
  const configuration = readAdmissionConfiguration(admin);
  const rows = await configuration, config = readCoreConfig(rows);
  if (!config) return emit({ type: 'error', code: 'TURN_CORE_DISABLED' });
  const settings = await readAdmissionSettings(admin, configuration);
  const admitted = await deps.newWork.message(input.actorId, Promise.resolve(settings));
  if (!admitted.ok) return emit({ type: 'error', code: GATE_CODES[admitted.reason] });

  // 1. The workspace, on the read client; refused here, nothing was charged.
  const { data, error } = await deps.clients.read.rpc('topic_turn_source', { p_actor_id: input.actorId, p_draft_id: input.draftId,
    p_request_id: input.requestId });
  if (error) return emit({ type: 'error', code: CODE.exec(error.message ?? '')?.[1] ?? 'TURN_OPEN_FAILED' });
  const workspace = source.safeParse(data);
  if (!workspace.success) return emit({ type: 'error', code: 'TURN_OPEN_FAILED' });
  const { sessionId, moduleId, skillId, revisionId, packageHash, resources, material } = workspace.data;

  // 2. The quote of the workspace's module, before anything is frozen.
  let quote;
  try {
    const module = await readAdmissionModule(admin, moduleId);
    if (module.error || module.data?.active !== true || typeof module.data.model_id !== 'string')
      return emit({ type: 'error', code: 'OPC_TOPIC_SKILL_MISSING' });
    const budgets = await readPurposeBudgets(admin, configuration);
    quote = await chatQuote(admin, { configuration: rows, modelId: module.data.model_id, deps: deps.pricing,
      inputBytes: budgets?.interactive.inputBytes ?? MAX_INPUT_BYTES,
      use: { phase: 'skill', requestFormat: AGENT_TURN_REQUEST_FORMAT, purpose: 'interactive' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return emit({ type: 'error', code: error instanceof QuoteError ? error.code : /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message
      : 'TURN_QUOTE_UNAVAILABLE' });
  }
  if (Buffer.byteLength(input.text) > quote.inputLimit) return emit({ type: 'error', code: 'TURN_INPUT_TOO_LARGE' });
  const thresholds = rowFor(rows, RESEARCH_THRESHOLDS_KEY);
  const startCredits = startThresholdCredits(thresholds.error ? null : thresholds.data?.value, quote.model, 'ordinary', quote.q,
    quote.multiplier);
  if (startCredits === undefined) return emit({ type: 'error', code: 'TURN_START_THRESHOLD_UNCONFIGURED' });

  // 3. Open: one call, no tools, no positioning check (a workspace exists only for a confirmed positioning).
  // topic: turn_open refuses a request the old path holds, under this conversation's lock.
  const policy = { ...turnPolicy({ q: quote.q, multiplier: quote.multiplier, modelUpperUsd: quote.upperUsd, startThresholdCredits: startCredits,
    limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 }, stopLoss: config.stopLoss, historyItems: HISTORY_ITEMS,
    inputBytes: quote.inputLimit, pricing: quote.pricing, frozen: { modelId: quote.modelId, model: quote.model } }), topic: true };
  let opened;
  try { opened = await db.open({ actorId: input.actorId, sessionId, requestId: input.requestId, kind: 'chat', policy }); }
  catch (error) { return emit({ type: 'error', code: error instanceof TurnDatabaseError ? error.code : 'TURN_OPEN_FAILED' }); }
  emit({ type: 'opened', turnId: opened.turnId, reservedCredits: opened.reservedCredits, replay: opened.replay });
  if (opened.replay) return emit({ type: 'error', code: 'TURN_REQUEST_REPLAYED', turnId: opened.turnId });
  const turnId = opened.turnId;
  const close = (kind: CloseKind, extra: { reply?: string; refundAll?: boolean; failureCode?: string } = {}) =>
    db.close({ actorId: input.actorId, turnId, kind, delivered: extra.reply !== undefined, refundAll: extra.refundAll,
      failureCode: extra.failureCode ?? null, messages: extra.reply === undefined ? []
        : [{ role: 'user', content: input.text }, { role: 'assistant', content: extra.reply }] });

  let text = '', stopped: TurnStop | undefined, seq = 0;
  try {
    // 4. The prompt: the Skill text with the plan's resources (shared, cached), then the workspace's rules and the reply language;
    // the frozen material and the user's words in the current message, as data.
    const guard = settings.ok ? settings.identityGuard ?? true : true;
    const skill = await reportSkillText(admin, { actorId: input.actorId, moduleId, skillId, revisionId, packageHash, resources,
      maxBytes: quote.inputLimit });
    const shared = withBrandIdentity(skill, guard);
    const instructions = shared + '\n' + TOPIC_WORKSPACE_INSTRUCTION + '\n'
      + replySettingInstructions(effectiveReplyLocale(opened.replyLanguage));
    // The date, for the plan's calendar days; in the message, so the shared prompt stays cached.
    const current = runtimeScopeInput(`Today is ${new Date().toISOString().slice(0, 10)}.\n\n${input.text}`, material);
    const promptCache = freezeSharedPromptCache({ real: true, model: quote.model, cacheWriteUsdPerMillion:
      quote.providerLimits.cacheWriteUsdPerMillion, instructions, prefixChars: shared.length, historyMarker: false });
    const request: RequestContext = { providerRequestFormat: AGENT_TURN_REQUEST_FORMAT, tools: [], network: 'deny',
      reasoning: quote.reasoning, ...(promptCache ? { promptCache } : {}) };
    const callPolicy = { modelId: quote.modelId, provider: 'openrouter', account: quote.identity.account, model: quote.model,
      protocol: 'openrouter-chat-v1' as const, providerLimits: quote.providerLimits, upperUsd: quote.upperUsd, outputLimit: quote.outputLimit,
      inputLimit: quote.inputLimit, automaticRetry: false, hiddenTools: false, lookupSupported: true };
    const callDeps = { db, slots: deps.slots, actorId: input.actorId, turnId, nextSeq: () => ++seq,
      adapter: openRouterAdapter({ credential: quote.credential, transport: deps.transport }) };
    const left = quote.inputLimit - Buffer.byteLength(instructions) - Buffer.byteLength(current) - 8192;
    const history = trimHistory(projectHistory(opened.history), Math.max(left, 0));
    const output = await runRuntime({
      model: quote.model, instructions, input: current, session: turnSession(history),
      maxOutputTokens: quote.outputLimit, maxTurns: 1, reasoning: quote.reasoning, tools: [], stream: true,
      selectHistory: async (items, incoming) => [...items, ...incoming],
      onText: delta => { text += delta; emit({ type: 'text', delta }); },
      exchange: async (_sequence, body, onChunk) => {
        const built = openRouterRequestBody(body, { context: request, policy: callPolicy as never, phase: 'ordinary', primaryDialogue: true });
        try { assertRuntimeRequestCapacity(built, quote.inputLimit); }
        catch { stopped = new TurnStop('TURN_INPUT_TOO_LARGE'); throw stopped; }
        const gate = await deps.newWork.calls(input.actorId, 1, 'bill2.v2');
        if (!gate.ok) { stopped = new TurnStop(GATE_CODES[gate.reason]); throw stopped; }
        return modelCall(callDeps, quote, built, onChunk)
          .catch(error => { if (error instanceof TurnStop) stopped = error; throw error; });
      },
    });
    const reply = output || text;
    const closed = await close('completed', { reply });
    if (closed.closeKind === 'erased') return emit({ type: 'error', code: 'TURN_TOMBSTONED', turnId });
    emit({ type: 'result', turnId, body: reply, chargedCredits: closed.chargedCredits, settlement: closed.settlement });
  } catch (error) {
    const code = stopped ? stopped.code : error instanceof TurnStop ? error.code : error instanceof TurnDatabaseError ? error.code : 'TURN_FAILED';
    const plan = CLOSES[code] ?? { kind: 'failed' as const, refundAll: true };
    await swallow('turn_close_failed', close(plan.kind, { refundAll: plan.refundAll, failureCode: code.toLowerCase() }), undefined,
      { category: 'ai' });
    emit({ type: 'error', code, turnId });
  }
}
