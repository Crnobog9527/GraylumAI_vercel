/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { memberLevelDenied } from '../skills/memberOnly';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { effectiveReplyLocale } from '../../shared/replyLanguage';
import { openRouterAdapter } from './provider/openRouterAdapter';
import { withBrandIdentity } from '../modelIdentity/brandIdentity';
import { planTurnInstructions } from '../opc/planPrompt';
import { readAdmissionConfiguration, readAdmissionModule } from './admission/admissionConfiguration';
import { assertRuntimeRequestCapacity, runtimeScopeInput } from './agent/context';
import { readAdmissionSettings } from './admission/newWorkGate';
import { freezeSharedPromptCache } from './provider/promptCache';
import { AGENT_TURN_REQUEST_FORMAT, openRouterRequestBody, type RequestContext } from './provider/providerRequest';
import { readPurposeBudgets } from './settings/purposeBudgets';
import { replySettingInstructions } from './agent/replyLanguage';
import { RESEARCH_THRESHOLDS_KEY } from './research/researchAdmission';
import { runRuntime } from './agent/runner';
import { rowFor } from './settings/settingsRows';
import { swallow } from '../../lib/swallow';
import { modelCall, TurnStop } from './call';
import { CLOSES, GATE_CODES, HISTORY_ITEMS, readCoreConfig, type ChatDeps } from './chat';
import { turnDatabase, TurnDatabaseError, type CloseKind } from './db';
import { projectHistory, trimHistory, turnSession } from './history';
import { projectMentorHistory } from './mentorPrompt';
import { startThresholdCredits, turnPolicy } from './policy';
import { chatQuote, QuoteError } from './quote';
import { reportSkillText } from './reportSkill';
import type { TurnEvent } from './sse';

/*
 * CORE-PATH-V2 V2-10b kind=plan: the first-week plan of a published positioning, one model call, no tools. As the old path
 * (opc.prepareStep purpose=plan): metered by usage, no fixed price and no membership gate; the start threshold is the ordinary one
 * (controller 11-01). What the model returned is delivered and charged even when it is no usable plan (the old path's rule):
 * GET /api/turn/plan reads it as invalid and the page asks for a new request. A plan cannot be stopped, and with one call it
 * cannot pause (the freeze covers min(G, L)). Round trips: one read (mentor_source_check, the source chain, before anything is
 * frozen) plus five: turn_open (which checks the draft, round, module and archived business under its locks, turn_plan_context),
 * the call's three writes and turn_close. The read and the open are not one transaction: a source revoked in between (milliseconds)
 * still yields one plan the user pays for, which cannot be repeated to Graylum's loss (AGENTS 5).
 */
export const planTurnRequest = z.object({
  kind: z.literal('plan'), sessionId: z.string().uuid(), requestId: z.string().uuid(), moduleId: z.string().uuid(),
  stepId: z.string().min(1).max(64), text: z.string().trim().min(1).max(8000),
}).strict();
export type PlanInput = Omit<z.infer<typeof planTurnRequest>, 'kind'> & { actorId: string };

const MAX_INPUT_BYTES = 90000;
const sourceChecked = z.object({ allowed: z.boolean(), businessContext: z.unknown().optional(),
  sourceDrafts: z.array(z.string().uuid()).default([]) });
const planContext = z.object({ roundId: z.string().uuid(), moduleId: z.string().uuid(), skillId: z.string().uuid(),
  revisionId: z.string().uuid(), packageHash: z.string(), resources: z.array(z.string()),
  work: z.record(z.string(), z.unknown()) }).passthrough();
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export async function runPlanTurn(deps: ChatDeps, input: PlanInput, emit: (event: TurnEvent) => void): Promise<void> {
  const { admin } = deps, db = turnDatabase(deps.clients);
  // 1. The catalog (cached), the gates and the quote of the module's model, before anything is frozen.
  const configuration = readAdmissionConfiguration(admin);
  const rows = await configuration, config = readCoreConfig(rows);
  if (!config) return emit({ type: 'error', code: 'TURN_CORE_DISABLED' });
  const settings = await readAdmissionSettings(admin, configuration);
  const admitted = await deps.newWork.message(input.actorId, Promise.resolve(settings));
  if (!admitted.ok) return emit({ type: 'error', code: GATE_CODES[admitted.reason] });
  let quote;
  try {
    const module = await readAdmissionModule(admin, input.moduleId);
    if (module.error || module.data?.active !== true || typeof module.data.model_id !== 'string'
      || await memberLevelDenied(admin, input.actorId, module.data.required_member_level))
      return emit({ type: 'error', code: 'TURN_PLAN_DENIED' });
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

  // 2. The draft's whole source chain, on the read client; refused here, nothing was charged.
  let source: z.infer<typeof sourceChecked>;
  try {
    const { data, error } = await deps.clients.read.rpc('mentor_source_check', { p_actor_id: input.actorId, p_session_id: input.sessionId });
    if (error) throw new Error('TURN_OPEN_FAILED');
    source = sourceChecked.parse(data);
  } catch { return emit({ type: 'error', code: 'TURN_OPEN_FAILED' }); }
  if (!source.allowed) return emit({ type: 'error', code: 'TURN_PLAN_DENIED' });

  // 3. Open: one call, no tools. turn_plan_context checks these under turn_open's locks and answers what the prompt needs.
  const policy = { ...turnPolicy({ q: quote.q, multiplier: quote.multiplier, modelUpperUsd: quote.upperUsd, startThresholdCredits: startCredits,
    limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 }, stopLoss: config.stopLoss, historyItems: HISTORY_ITEMS,
    inputBytes: quote.inputLimit, pricing: quote.pricing, frozen: { modelId: quote.modelId, model: quote.model } }),
  plan: { moduleId: input.moduleId, stepId: input.stepId, requestId: input.requestId, inputHash: sha256(input.text), sourceChecked: true,
    sourceDrafts: source.sourceDrafts } };
  let opened;
  try { opened = await db.open({ actorId: input.actorId, sessionId: input.sessionId, requestId: input.requestId, kind: 'plan', policy }); }
  catch (error) { return emit({ type: 'error', code: error instanceof TurnDatabaseError ? error.code : 'TURN_OPEN_FAILED' }); }
  emit({ type: 'opened', turnId: opened.turnId, reservedCredits: opened.reservedCredits, replay: opened.replay });
  // A repeated request never runs the model again; the page reads the first one's plan by its request.
  if (opened.replay) return emit({ type: 'error', code: 'TURN_REQUEST_REPLAYED', turnId: opened.turnId });
  const turnId = opened.turnId;
  let roundId = '';
  const close = (kind: CloseKind, extra: { body?: string; refundAll?: boolean; failureCode?: string } = {}) =>
    db.close({ actorId: input.actorId, turnId, kind, messages: [], delivered: extra.body !== undefined, refundAll: extra.refundAll,
      failureCode: extra.failureCode ?? null, ...(extra.body === undefined ? {} : { kindResult: { body: extra.body, roundId } }) });

  let text = '', stopped: TurnStop | undefined, seq = 0;
  try {
    const context = planContext.parse(opened.kindContext);
    roundId = context.roundId;
    // 4. The prompt: the Skill text with the plan's resources (shared, cached), then the plan's rules and the reply language;
    // the published work and the user's constraints in the current message, as data.
    const guard = settings.ok ? settings.identityGuard ?? true : true;
    const skill = await reportSkillText(admin, { actorId: input.actorId, moduleId: input.moduleId, skillId: context.skillId,
      revisionId: context.revisionId, packageHash: context.packageHash, resources: context.resources, maxBytes: quote.inputLimit });
    const shared = withBrandIdentity(skill, guard);
    const instructions = shared + '\n' + planTurnInstructions(input.stepId) + '\n'
      + replySettingInstructions(effectiveReplyLocale(opened.replyLanguage));
    const current = runtimeScopeInput(input.text, { content: { brief: 'plan:' + input.stepId, material: '', roundId: context.roundId,
      work: { ...context.work, ...(source.businessContext ? { businessContext: source.businessContext } : {}) } } });
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
    const history = trimHistory(projectHistory(projectMentorHistory(opened.history)), Math.max(left, 0));
    const output = await runRuntime({
      model: quote.model, instructions, input: current, session: turnSession(history),
      maxOutputTokens: quote.outputLimit, maxTurns: 1, reasoning: quote.reasoning, tools: [], stream: true,
      selectHistory: async (items, incoming) => [...items, ...incoming],
      onText: delta => { text += delta; emit({ type: 'text', delta }); },
      exchange: async (_sequence, body, onChunk) => {
        const built = openRouterRequestBody(body, { context: request, policy: callPolicy as never, phase: 'ordinary', primaryDialogue: true });
        try { assertRuntimeRequestCapacity(built, quote.inputLimit); }
        catch { stopped = new TurnStop('TURN_INPUT_TOO_LARGE'); throw stopped; }
        // The pause and the call limits again before the paid call: nothing is written or sent when refused.
        const gate = await deps.newWork.calls(input.actorId, 1, 'bill2.v2');
        if (!gate.ok) { stopped = new TurnStop(GATE_CODES[gate.reason]); throw stopped; }
        return modelCall(callDeps, quote, built, onChunk)
          .catch(error => { if (error instanceof TurnStop) stopped = error; throw error; });
      },
    });
    // 5. Close: charged by usage, whatever the body is (the read judges it). A tombstone found here saves nothing.
    const body = output || text;
    const closed = await close('completed', { body });
    if (closed.closeKind === 'erased') return emit({ type: 'error', code: 'TURN_TOMBSTONED', turnId });
    emit({ type: 'result', turnId, body, chargedCredits: closed.chargedCredits, settlement: closed.settlement });
  } catch (error) {
    const code = stopped ? stopped.code : error instanceof TurnStop ? error.code : error instanceof TurnDatabaseError ? error.code : 'TURN_FAILED';
    // Nothing delivered: the user pays nothing; an unknown outcome waits for recovery. A failed close is left to recovery too.
    const plan = CLOSES[code] ?? { kind: 'failed' as const, refundAll: true };
    await swallow('turn_close_failed', close(plan.kind, { refundAll: plan.refundAll, failureCode: code.toLowerCase() }), undefined,
      { category: 'ai' });
    emit({ type: 'error', code, turnId });
  }
}
