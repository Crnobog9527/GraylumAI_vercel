/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useEffect, useRef } from "react";

export const OPENING_FAILED_NOTICE =
  "AI 教练引导这次没有加载成功。你可以直接填写右侧表单，或刷新后重试；不会重复生成或重复扣费。";

type Turn = { executionId?: string; stepId: string; roundId?: string | null; kind: string };
type Execution = { executionId: string; state?: string | null; body?: string | null; primaryBody?: string | null };
type Draft = { roundId?: string | null; turns?: unknown } | undefined | null;

/**
 * True once the step has a coach turn in this round whose execution finished with a reply. A turn
 * alone is not enough: a failed or cancelled opening is still projected as an `opening` turn.
 */
export function stepHasReply(turns: readonly Turn[], executions: readonly Execution[], roundId: string | null | undefined,
  stepId: string) {
  const replied = new Set(executions.filter(execution => (execution.state === "completed" || execution.state === "cost_pending")
    && Boolean(execution.body || execution.primaryBody)).map(execution => execution.executionId));
  return turns.some(turn => turn.stepId === stepId && Boolean(turn.executionId && replied.has(turn.executionId))
    && (!Object.hasOwn(turn, "roundId") || turn.roundId === roundId)
    && (turn.kind === "mentor" || turn.kind === "organizer" || turn.kind === "opening"));
}

/** Clear only the failed-opening notice, and only once that step's coach reply has arrived. */
export function openingNoticeResolved(failedStep: string | null, notice: string, draft: Draft, executions: unknown) {
  return Boolean(failedStep && notice === OPENING_FAILED_NOTICE && draft
    && stepHasReply((draft.turns ?? []) as Turn[], (executions ?? []) as Execution[], draft.roundId, failedStep));
}

/**
 * The failed-opening notice is shown until that step gets a coach reply by any route; before,
 * only a successful opening cleared it, so a working conversation still showed the failure.
 * Returns the notice text to set when an opening fails.
 */
export function useOpeningFailureNotice(draft: Draft, executions: unknown, notice: string, setNotice: (value: string) => void) {
  const failedStep = useRef<string | null>(null);
  useEffect(() => {
    if (!openingNoticeResolved(failedStep.current, notice, draft, executions)) return;
    failedStep.current = null;
    setNotice("");
  }, [draft, executions, notice, setNotice]);
  return useCallback((stepId: string) => { failedStep.current = stepId; return OPENING_FAILED_NOTICE; }, []);
}
