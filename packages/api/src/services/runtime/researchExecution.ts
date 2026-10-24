/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-3b PR-3: the research tools of one admitted positioning mentor turn, built from its frozen
// context and run only. The actor comes from the trusted runtime; tool prices, routes and the subcall allowance
// come from the run, never from the model or current settings. Each subcall claims the run's next free BILL2
// sequence; a model call that finds one of this answer's subcalls in its slot moves past it (responseAfterResearch).
import { z } from 'zod';
import type { ResearchTurnEvent } from '../../shared/researchTurn';
import { toolCallPolicies } from '../bill2/runPolicies';
import { toolSubcallBilling } from '../bill2/toolSubcall';
import { checkVendorRateLimit } from '../redisRateLimiter';
import { databaseRuntimeResearchStore } from '../research/runtime/store';
import { platformSecretReader } from '../research/runtime/secrets';
import { ResearchPause } from '../research/runtime/subcall';
import type { ResearchToolContext } from '../research/runtime/toolContext';
import { RESEARCH_TOOL_NAMES, type ResearchToolName } from '../research/tools/schemas';
import { canonicalAccount, type CanonicalAccount } from '../research/tools/accountLinks';
import type { SocialPlatform } from '../research/vendors/types';
import type { RuntimeExecution } from './paygResume';
import { researchToolBytes } from './researchAdmission';
import { fastSearchOnly, researchRuntimeTools } from './researchRuntimeTool';
import { frozenResearchConfig, type FrozenResearchTurn } from './researchTurn';
import type { RuntimeTool } from './runner';
import type { SessionRpc } from './session';
import { readBillingRpc } from '../bill2/readRetry';
import { MIN_MODEL_DISPATCH_MS, type RuntimeBudget } from './budget';

const runCalls = z.object({ calls: z.array(z.object({ id: z.string().uuid(), sequence: z.number().int().positive(),
  providerId: z.string().nullable() }).passthrough()) }).passthrough();

export interface ResearchExecution {
  tools: RuntimeTool[];
  /** Request bytes of the offered research tool definitions. */
  definitionBytes: number;
  /** Input kept free in the first call for one tool result and the reply after it. */
  reserve: number;
  /** Whether a BILL2 slot holds a research subcall of this answer (0267 call_kind='tool'), with or without a receipt. */
  isSubcall(sequence: number): Promise<boolean>;
  /** Only this invocation's successful tool claims; replay still consults the database. */
  claimedSubcall?(sequence: number): boolean;
}

/** Room kept for one slow paid lookup (BILL2 claim, dispatch, supplier answer, record) on top of the reply's own minimum. */
const LOOKUP_MS = 30_000;

/** Whether this invocation can still afford one slow paid lookup and the model reply after it (no budget: no limit). */
export function lookupTimeLeft(budget: Pick<RuntimeBudget, 'assertCanStart'> | undefined): boolean {
  try { budget?.assertCanStart(MIN_MODEL_DISPATCH_MS + LOOKUP_MS); return true; } catch { return false; }
}

export function researchExecution(input: {
  research: FrozenResearchTurn | undefined; tools: readonly string[];
  execution: Pick<RuntimeExecution, 'sessionId' | 'runId' | 'epoch' | 'billing' | 'live'>;
  executionId: string; actorId: string; database: SessionRpc; budget?: RuntimeBudget;
  emit: (event: ResearchTurnEvent) => void;
  /** BILL2 confirmed account or content erasure while recording a subcall: nothing more may reach the client. */
  onClosed: () => void;
  /** A subcall cannot start now: the host saves this slot as the turn's pause point (payg_wait, BILL-PAYG). */
  onPause: (point: ResearchPause['point'], state: ResearchPause['state']) => void;
  /** false = the round's time budget cannot cover another supplier request; nothing is sent. */
  canSend: () => boolean;
  /** Reserves one runtime call slot before each supplier BILL2 claim. */
  callGate?: () => Promise<void>;
  /** Clears the per-claim gate marker after a tool finishes without pausing. */
  onSubcallSettled?: () => void;
  now?: () => Date;
}): ResearchExecution | null {
  const { research, execution } = input;
  if (!research) return null;
  const names = RESEARCH_TOOL_NAMES.filter(name => input.tools.includes(name)) as ResearchToolName[];
  const readCalls = async () => {
    const result = await readBillingRpc(input.database,'bill2_read',
      { p_actor_id: input.actorId, p_run_id: execution.runId },input.budget);
    if (result.error) throw new Error('BILL2_DATABASE_UNAVAILABLE');
    return runCalls.parse(result.data).calls;
  };
  const scope = { userId: input.actorId, sessionId: execution.sessionId, executionId: input.executionId };
  const store = databaseRuntimeResearchStore({ admin: input.database, scope });
  const recorded = toolSubcallBilling({ admin: input.database, actorId: input.actorId, runId: execution.runId });
  const claimedSubcalls = new Set<number>();
  // Tools/subcalls are serial under the runtime owner epoch. Refresh at each tool boundary, because
  // model calls share this sequence. SQL still checks every claim, budget, epoch and unsettled call.
  let nextSequence: number | undefined;
  let closed = false;
  const billing: typeof recorded = { ...recorded, async claim(sequence, payload) {
    const claimed = await recorded.claim(sequence, payload);
    if (claimed.state === 'claimed') {
      claimedSubcalls.add(sequence);
      nextSequence = sequence + 1;
    }
    return claimed;
  }, async record(callId, evidence) {
    const saved = await recorded.record(callId, evidence);
    if (saved.accountClosed || saved.contentDeleted) { closed = true; input.onClosed(); }
    return saved;
  } };
  const ctx: ResearchToolContext = {
    scope, executionId: input.executionId, config: frozenResearchConfig(research), store,
    emit: event => { if (!closed) input.emit(event); },
    now: input.now ?? (() => new Date()),
    // A paid lookup only starts with time left for a slow one and for the reply after it: a round stopped here continues
    // on the next reply (#1308 staging: a slow database ran a discovery into the 265s limit and the reply failed).
    lookupTime: () => lookupTimeLeft(input.budget),
    subcall: {
      policies: toolCallPolicies(execution.billing.callPolicy),
      // Replay never claims (like a replayed model call): saved evidence answers, anything unsaved stays pending.
      billing: execution.live ? billing : { ...billing, claim: async () => { throw new Error('RUNTIME_RESPONSE_PENDING'); } },
      evidence: store.evidence(),
      // Claims on a run are serial (one owner, no unsettled call), so the next free slot is the count plus one.
      nextSequence: async () => nextSequence ??= (await readCalls()).length + 1,
      phase: research.phase, ...(execution.epoch !== undefined ? { runtimeEpoch: execution.epoch } : {}),
      secrets: platformSecretReader(input.database), rateCounter: checkVendorRateLimit,
      // A recovery replay cannot create a supplier request or BILL2 claim, so it must not consume live quota.
      ...(execution.live && input.callGate ? { callGate: input.callGate } : {}),
      newId: () => { throw new Error('RESEARCH_OPERATION_ID_REQUIRED'); },
      beforeSend: async () => input.canSend(),
      ...(input.now ? { now: input.now } : {}),
    },
  };
  // A subcall slot of this run (any state) is one this answer already spent, also across a pause or a restart.
  const usedSubcalls = async () => {
    let used = 0;
    for (const call of await readCalls()) if (await isSubcall(call)) used++;
    return used;
  };
  async function isSubcall(call: z.infer<typeof runCalls>['calls'][number]) {
    // An object for a tool call of this answer in any state (also one recovery cancelled before its receipt), null otherwise.
    const kind = await input.database.rpc('research_runtime_call_charge',
      { a: input.actorId, s: execution.sessionId, e: input.executionId, p_call: call.id });
    if (kind.error) throw new Error('RESEARCH_STATE_UNAVAILABLE');
    return kind.data !== null && typeof kind.data === 'object';
  }
  // CHAT-AUTO-CONTEXT C: social_account takes accounts only from the user's benchmark table or the message being answered.
  const freeChat = research.freeChat ? { accounts: {
    async benchmarkAccounts() {
      const result = await input.database.rpc('research_chat_benchmark_accounts',
        { a: input.actorId, s: execution.sessionId, e: input.executionId });
      if (result.error) throw new Error('RESEARCH_STATE_UNAVAILABLE');
      return (Array.isArray(result.data) ? result.data : []).flatMap((item: { platform?: unknown; account?: unknown }) => {
        if (typeof item?.platform !== 'string' || typeof item.account !== 'string') return [];
        const account = canonicalAccount(item.platform as SocialPlatform, item.account);
        return account ? [{ platform: item.platform as SocialPlatform, account } satisfies CanonicalAccount] : [];
      });
    },
    currentMessage: () => store.authorization.userMessage(scope, input.executionId),
  } } : undefined;
  return {
    // After a confirmed erasure the tool call ends the turn instead of handing a result to the model.
    // A pause ends the turn at the subcall's slot; the resumed turn runs this tool call again.
    // A free chat reply counts what it already spent (CHAT-AUTO-CONTEXT C); the mentor turn keeps its single-call round.
    tools: researchRuntimeTools(ctx, names, freeChat ? { usedSubcalls, freeChat } : {}).map(tool => ({ ...tool, async execute(args, callId) {
      let result;
      try { result = await tool.execute(args, callId); }
      catch (error) {
        if (error instanceof ResearchPause && !closed) input.onPause(error.point, error.state);
        throw error;
      }
      finally { nextSequence = undefined; }
      if (closed) throw new Error('RUNTIME_ACCOUNT_CLOSED');
      input.onSubcallSettled?.();
      return result;
    } })),
    definitionBytes: researchToolBytes(names, fastSearchOnly(ctx.config), Boolean(research.freeChat)), reserve: research.reserve,
    claimedSubcall: sequence => claimedSubcalls.has(sequence),
    async isSubcall(sequence) {
      const call = (await readCalls()).find(item => item.sequence === sequence);
      return call ? isSubcall(call) : false;
    },
  };
}

/**
 * The stored response of a model call, or null when its slot is still free. After a research tool the local
 * sequence lags behind the subcalls that tool claimed (on replay it claims none), so a slot holding one of this
 * answer's subcalls (settled, pending or cancelled without a receipt) is skipped; a tool slot never holds a model
 * response, and SQL still refuses a new claim while any call is unsettled. Any other conflict still fails.
 */
export async function responseAfterResearch<T>(respond: (sequence: number) => Promise<T>, start: number,
  research: Pick<ResearchExecution, 'isSubcall' | 'claimedSubcall'> | null, maxCalls: number): Promise<{ sequence: number; existing: T }> {
  for (let sequence = start; ; sequence++) {
    // Avoid manufacturing a response conflict for a tool slot we just claimed ourselves. A new
    // invocation has no such knowledge and follows the original scoped database recovery below.
    if (sequence < maxCalls && research?.claimedSubcall?.(sequence)) continue;
    try { return { sequence, existing: await respond(sequence) }; }
    catch (error) {
      if (!research || sequence >= maxCalls || !(error instanceof Error) || error.message !== 'RUNTIME_RESPONSE_CONFLICT'
        || !await research.isSubcall(sequence)) throw error;
    }
  }
}
