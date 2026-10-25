/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {StagingAccessError} from './stagingErrors';
import type { FrozenRun, FrozenPaygRun } from '../bill2/service';
import { modelCallPolicies } from '../bill2/runPolicies';
import type { RuntimeCallGate } from './newWorkGate';
import type { PaygWait, ResumeInput } from './paygRuntime';

export type RuntimeExecution = {
  executionId: string; sessionId: string; runId: string; live: boolean; cancelRequested: boolean; state: string;
  pausedReason?: string; unavailableReason?: string; historyFrozen?: boolean; historyOmitted?: boolean; context: unknown;
  gatePassed?: boolean;
  billing: FrozenRun | FrozenPaygRun;
  cursor?: number; epoch?: number; remainingCalls?: number; primaryResult?: { body: string };
  result: { kind: string; evidenceRef: string; evidenceHash: string; body: string; summary?: string;
    stopped?: boolean; completeness?: "complete" | "stopped" | "length_limit"; organized?: boolean;
    summaryOmitted?: boolean; messageFirst?: boolean; envelopeCompact?: boolean } | null;
};
export async function beginPaygExecution(input: {
  executionId: string; resume?: ResumeInput;
  read: (action: string, value?: unknown) => Promise<RuntimeExecution>;
  actor: () => Promise<string>; callGate: RuntimeCallGate;
  resumePricing?: (policies: FrozenRun['callPolicy']) => Promise<void>;
  /** LIB-4b: sees the execution as first read, before any wait (or its saved primary body) can be returned. */
  observe?: (execution: RuntimeExecution) => void;
}): Promise<{ execution: RuntimeExecution; resumedGate: boolean; wait?: PaygWait }> {
  const execution = await input.read(input.resume ? 'read' : 'begin');
  input.observe?.(execution);
  const wait = (unavailable?: PaygWait['unavailable']): PaygWait => ({
    state: execution.state as PaygWait['state'],
    code: unavailable === 'paused' ? 'RUNTIME_NEW_CALLS_STOPPED' : unavailable === 'usage_configuration_required' ? 'RUNTIME_USAGE_CONFIGURATION_REQUIRED'
      : execution.state === 'waiting_credits' ? 'RUNTIME_WAITING_CREDITS' : 'RUNTIME_WAITING_RESUME',
    executionId: input.executionId, cursor: execution.cursor!, epoch: execution.epoch!, remainingCalls: execution.remainingCalls!,
    ...(execution.primaryResult ? { body: execution.primaryResult.body } : {}), ...(unavailable ? { unavailable } : {}),
  });
  if (execution.pausedReason === 'user_stop') return {execution, resumedGate: false};
  if (execution.billing?.contractVersion === 'bill2.v2' && ['waiting_credits', 'waiting_resume'].includes(execution.state)) {
    if (!input.resume) return { execution, resumedGate: false, wait: wait() };
    if (input.resume.executionId !== input.executionId || input.resume.cursor !== execution.cursor
      || input.resume.epoch !== execution.epoch) throw new StagingAccessError('RUNTIME_RESUME_CONFLICT');
    if (execution.remainingCalls === 0) {
      // Exhaustion grants replay only. SQL checks cursor/epoch, source revisions and
      // settled calls; live=false can finish saved receipts, never mint another call.
      await input.actor();
      return {execution:await input.read('payg_resume', {cursor:input.resume.cursor,epoch:input.resume.epoch}),
        resumedGate:false};
    }
    let resumedGate = false;
    const checkPause = execution.state !== 'waiting_credits' && execution.gatePassed !== true
      && execution.remainingCalls === execution.billing.limits.maxCalls;
    const callGate = async (reserve: boolean) => {
      const actorId = await input.actor();
      return checkPause ? reserve ? input.callGate(actorId, 1, 'bill2.v2')
        : input.callGate(actorId, 1, 'bill2.v2', false)
        : input.callGate(actorId, 1, 'bill2.v2', reserve, false);
    };
    // The durable checkpoint records whether this same call already passed its
    // gate before waiting. Recheck without reserving it a second time.
    if (execution.state === 'waiting_credits' || execution.gatePassed === true) {
      try {
        const verdict = await callGate(false);
        if (!verdict.ok) return { execution, resumedGate: false, wait: wait(verdict.reason) };
        resumedGate = true;
      } catch { return { execution, resumedGate: false, wait: wait('limit_unavailable') }; }
    }
    else {
      // A waiting_resume before its first call gate reserves one slot now.
      try {
        const verdict = await callGate(true);
        if (!verdict.ok) return { execution, resumedGate: false, wait: wait(verdict.reason) };
        resumedGate = true;
      } catch { return { execution, resumedGate: false, wait: wait('limit_unavailable') }; }
    }
    if (execution.billing.mode === 'staging_test') {
      if (!input.resumePricing) return { execution, resumedGate: false, wait: wait('RUNTIME_PRICE_UNCONFIRMED') };
      // Tool-route prices (RT-3b PR-3) have no model price row; their frozen expiry is checked by each claim (0255).
      try { await input.resumePricing(modelCallPolicies(execution.billing.callPolicy)); }
      catch { return { execution, resumedGate: false, wait: wait('RUNTIME_PRICE_CONFIGURATION_PENDING') }; }
    }
    try {
      return { execution: await input.read('payg_resume', { cursor: input.resume.cursor, epoch: input.resume.epoch }),
        resumedGate };
    } catch (error) {
      // Only a refused test window or model maps here (executorRpc): this frozen round can never resume.
      if (error instanceof StagingAccessError && error.reason === 'RUNTIME_PRICE_CONFIGURATION_PENDING')
        return { execution, resumedGate: false, wait: { ...wait('RUNTIME_PRICE_CONFIGURATION_PENDING'), resumeClosed: true } };
      throw error;
    }
  }
  if (input.resume) throw new StagingAccessError('RUNTIME_RESUME_CONFLICT');
  return { execution, resumedGate: false };
}
