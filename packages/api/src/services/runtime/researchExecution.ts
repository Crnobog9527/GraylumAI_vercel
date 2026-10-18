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
import { POSITIONING_RESEARCH_TOOLS, type ResearchToolName } from '../research/tools/schemas';
import type { RuntimeExecution } from './paygResume';
import { researchToolBytes } from './researchAdmission';
import { fastSearchOnly, researchRuntimeTools } from './researchRuntimeTool';
import { frozenResearchConfig, type FrozenResearchTurn } from './researchTurn';
import type { RuntimeTool } from './runner';
import type { SessionRpc } from './session';

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
}

export function researchExecution(input: {
  research: FrozenResearchTurn | undefined; tools: readonly string[];
  execution: Pick<RuntimeExecution, 'sessionId' | 'runId' | 'epoch' | 'billing' | 'live'>;
  executionId: string; actorId: string; database: SessionRpc;
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
  const names = POSITIONING_RESEARCH_TOOLS.filter(name => input.tools.includes(name)) as ResearchToolName[];
  const readCalls = async () => {
    const result = await input.database.rpc('bill2_read', { p_actor_id: input.actorId, p_run_id: execution.runId });
    if (result.error) throw new Error('BILL2_DATABASE_UNAVAILABLE');
    return runCalls.parse(result.data).calls;
  };
  const scope = { userId: input.actorId, sessionId: execution.sessionId, executionId: input.executionId };
  const store = databaseRuntimeResearchStore({ admin: input.database, scope });
  const recorded = toolSubcallBilling({ admin: input.database, actorId: input.actorId, runId: execution.runId });
  let closed = false;
  const billing: typeof recorded = { ...recorded, async record(callId, evidence) {
    const saved = await recorded.record(callId, evidence);
    if (saved.accountClosed || saved.contentDeleted) { closed = true; input.onClosed(); }
    return saved;
  } };
  const ctx: ResearchToolContext = {
    scope, executionId: input.executionId, config: frozenResearchConfig(research), store,
    emit: event => { if (!closed) input.emit(event); },
    now: input.now ?? (() => new Date()),
    subcall: {
      policies: toolCallPolicies(execution.billing.callPolicy),
      // Replay never claims (like a replayed model call): saved evidence answers, anything unsaved stays pending.
      billing: execution.live ? billing : { ...billing, claim: async () => { throw new Error('RUNTIME_RESPONSE_PENDING'); } },
      evidence: store.evidence(),
      // Claims on a run are serial (one owner, no unsettled call), so the next free slot is the count plus one.
      nextSequence: async () => (await readCalls()).length + 1,
      phase: research.phase, ...(execution.epoch !== undefined ? { runtimeEpoch: execution.epoch } : {}),
      secrets: platformSecretReader(input.database), rateCounter: checkVendorRateLimit,
      ...(input.callGate ? { callGate: input.callGate } : {}),
      newId: () => { throw new Error('RESEARCH_OPERATION_ID_REQUIRED'); },
      beforeSend: async () => input.canSend(),
      ...(input.now ? { now: input.now } : {}),
    },
  };
  return {
    // After a confirmed erasure the tool call ends the turn instead of handing a result to the model.
    // A pause ends the turn at the subcall's slot; the resumed turn runs this tool call again.
    tools: researchRuntimeTools(ctx, names).map(tool => ({ ...tool, async execute(args, callId) {
      let result;
      try { result = await tool.execute(args, callId); }
      catch (error) {
        if (error instanceof ResearchPause && !closed) input.onPause(error.point, error.state);
        throw error;
      }
      if (closed) throw new Error('RUNTIME_ACCOUNT_CLOSED');
      input.onSubcallSettled?.();
      return result;
    } })),
    definitionBytes: researchToolBytes(names, fastSearchOnly(ctx.config)), reserve: research.reserve,
    async isSubcall(sequence) {
      const call = (await readCalls()).find(item => item.sequence === sequence);
      if (!call) return false;
      // An object for a tool call of this answer in any state (also one recovery cancelled before its receipt), null otherwise.
      const kind = await input.database.rpc('research_runtime_call_charge',
        { a: input.actorId, s: execution.sessionId, e: input.executionId, p_call: call.id });
      if (kind.error) throw new Error('RESEARCH_STATE_UNAVAILABLE');
      return kind.data !== null && typeof kind.data === 'object';
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
  research: Pick<ResearchExecution, 'isSubcall'> | null, maxCalls: number): Promise<{ sequence: number; existing: T }> {
  for (let sequence = start; ; sequence++) {
    try { return { sequence, existing: await respond(sequence) }; }
    catch (error) {
      if (!research || sequence >= maxCalls || !(error instanceof Error) || error.message !== 'RUNTIME_RESPONSE_CONFLICT'
        || !await research.isSubcall(sequence)) throw error;
    }
  }
}
