/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useEffect, useRef } from "react";

export const OPENING_FAILED_NOTICE =
  "AI 教练引导这次没有加载成功。你可以直接填写右侧表单，或刷新后重试；不会重复生成或重复扣费。";

type Turn = { stepId: string; roundId?: string | null; kind: string };

/**
 * True once the step has a coach turn in this round. An opening only runs while the step has none,
 * so a turn seen after a failed opening is a later success (the user's own message, or a retry).
 */
export function stepHasTurn(turns: readonly Turn[], roundId: string | null | undefined, stepId: string) {
  return turns.some(turn => turn.stepId === stepId
    && (!Object.hasOwn(turn, "roundId") || turn.roundId === roundId)
    && (turn.kind === "mentor" || turn.kind === "organizer" || turn.kind === "opening"));
}

type Draft = { roundId?: string | null; turns?: unknown } | undefined | null;

/** Clear only the failed-opening notice, and only once that step's coach turn has arrived. */
export function openingNoticeResolved(failedStep: string | null, notice: string, draft: Draft) {
  return Boolean(failedStep && notice === OPENING_FAILED_NOTICE && draft
    && stepHasTurn((draft.turns ?? []) as Turn[], draft.roundId, failedStep));
}

/**
 * The failed-opening notice is shown until that step gets a coach turn by any route; before,
 * only a successful opening cleared it, so a working conversation still showed the failure.
 * Returns the notice text to set when an opening fails.
 */
export function useOpeningFailureNotice(draft: Draft, notice: string, setNotice: (value: string) => void) {
  const failedStep = useRef<string | null>(null);
  useEffect(() => {
    if (!openingNoticeResolved(failedStep.current, notice, draft)) return;
    failedStep.current = null;
    setNotice("");
  }, [draft, notice, setNotice]);
  return useCallback((stepId: string) => { failedStep.current = stepId; return OPENING_FAILED_NOTICE; }, []);
}
