/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {StagingAccessError} from './stagingErrors';
import type { FrozenRun, FrozenPaygRun } from '../bill2/service';
import type { RuntimeCallGate } from './newWorkGate';
import type { PaygWait, ResumeInput } from './paygRuntime';

export type RuntimeExecution = {
  executionId: string; sessionId: string; runId: string; live: boolean; cancelRequested: boolean; state: string;
  pausedReason?: string; unavailableReason?: string; historyFrozen?: boolean; historyOmitted?: boolean; context: unknown;
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
}): Promise<{ execution: RuntimeExecution; resumedGate: boolean; wait?: PaygWait }> {
  const execution = await input.read(input.resume ? 'read' : 'begin');
  const wait = (unavailable?: PaygWait['unavailable']): PaygWait => ({
    state: execution.state as PaygWait['state'],
    code: unavailable === 'usage_configuration_required' ? 'RUNTIME_USAGE_CONFIGURATION_REQUIRED'
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
      // Exhaustion is terminal maintenance, not another model attempt. SQL
      // checks cursor/epoch and settled calls before using existing cancellation.
      await input.actor();
      return {execution:await input.read('payg_resume', {cursor:input.resume.cursor,epoch:input.resume.epoch}),
        resumedGate:false};
    }
    let verdict;
    try { verdict = await input.callGate(await input.actor(), execution.remainingCalls!, 'bill2.v2'); }
    catch { return { execution, resumedGate: false, wait: wait('limit_unavailable') }; }
    if (!verdict.ok) return { execution, resumedGate: false, wait: wait(verdict.reason) };
    if (execution.billing.mode === 'staging_test') {
      if (!input.resumePricing) return { execution, resumedGate: false, wait: wait('RUNTIME_PRICE_UNCONFIRMED') };
      try { await input.resumePricing(execution.billing.callPolicy); }
      catch { return { execution, resumedGate: false, wait: wait('RUNTIME_PRICE_CONFIGURATION_PENDING') }; }
    }
    try {
      return { execution: await input.read('payg_resume', { cursor: input.resume.cursor, epoch: input.resume.epoch }),
        resumedGate: true };
    } catch (error) {
      if (error instanceof StagingAccessError && error.reason === 'RUNTIME_PRICE_CONFIGURATION_PENDING')
        return { execution, resumedGate: false, wait: wait('RUNTIME_PRICE_CONFIGURATION_PENDING') };
      throw error;
    }
  }
  if (input.resume) throw new StagingAccessError('RUNTIME_RESUME_CONFLICT');
  return { execution, resumedGate: false };
}
