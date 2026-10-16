/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-3b PR-3: the research tools of one admitted positioning mentor turn, built from its frozen
// context and run only. The actor comes from the trusted runtime; tool prices, routes and the subcall allowance
// come from the run, never from the model or current settings. Each subcall claims the run's next free BILL2
// sequence; a model call that finds a recorded subcall in its slot moves past it (responseAfterResearch).
import { z } from 'zod';
import type { ResearchTurnEvent } from '../../shared/researchTurn';
import { toolCallPolicies } from '../bill2/runPolicies';
import { toolSubcallBilling } from '../bill2/toolSubcall';
import { checkVendorRateLimit } from '../redisRateLimiter';
import { databaseRuntimeResearchStore } from '../research/runtime/store';
import { platformSecretReader } from '../research/runtime/secrets';
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
  /** Whether a BILL2 slot holds a recorded research subcall: its receipt's provider id is the call itself (0255). */
  isSubcall(sequence: number): Promise<boolean>;
}

export function researchExecution(input: {
  research: FrozenResearchTurn | undefined; tools: readonly string[];
  execution: Pick<RuntimeExecution, 'sessionId' | 'runId' | 'epoch' | 'billing' | 'live'>;
  executionId: string; actorId: string; database: SessionRpc;
  emit: (event: ResearchTurnEvent) => void;
  /** false = the round's time budget cannot cover another supplier request; nothing is sent. */
  canSend: () => boolean;
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
  const billing = toolSubcallBilling({ admin: input.database, actorId: input.actorId, runId: execution.runId });
  const ctx: ResearchToolContext = {
    scope, executionId: input.executionId, config: frozenResearchConfig(research), store, emit: input.emit,
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
      newId: () => { throw new Error('RESEARCH_OPERATION_ID_REQUIRED'); },
      beforeSend: async () => input.canSend(),
      ...(input.now ? { now: input.now } : {}),
    },
  };
  return {
    tools: researchRuntimeTools(ctx, names),
    definitionBytes: researchToolBytes(names, fastSearchOnly(ctx.config)), reserve: research.reserve,
    async isSubcall(sequence) {
      const call = (await readCalls()).find(item => item.sequence === sequence);
      return Boolean(call && call.providerId === call.id);
    },
  };
}

/**
 * The stored response of a model call, or null when its slot is still free. After a research tool the local
 * sequence lags behind the subcalls that tool claimed (on replay it claims none), so a slot holding a recorded
 * subcall is skipped. Anything else that conflicts (a different model request, an unrecorded call) still fails.
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
