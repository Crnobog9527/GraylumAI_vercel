/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isOpeningInput } from "@repo/api/src/shared/opcQuestions";
import type { MentorRequest } from "./mentor-turn";

/**
 * "这一步先到这里" (AGENT-CORE R16): the user's click asks the mentor for this step's summary. It is a host
 * action, not something the user said: the conversation shows the button's words, never the raw marker,
 * and the reply is shown as the step's summary card. Confirming still takes the step's own confirmation card.
 */
export const STEP_SUMMARY_LABEL = "这一步先到这里";
/** The server's versioned marker (packages/api/src/shared/opcStepSummary.ts, not exported to the web package). */
export const STEP_SUMMARY_INPUT = "HOST_STEP_SUMMARY:v1";

export const isStepSummaryInput = (input: string | null | undefined) => input === STEP_SUMMARY_INPUT;

/**
 * The host request. It answers no card and names no field, and it never runs the organizer: the click is not a
 * new fact. A retry reuses this request id (the retained envelope), so the same click is never charged twice.
 */
export function stepSummaryRequest(draftId: string, stepId: string, requestId: string): MentorRequest {
  return { draftId, stepId, purpose: "mentor", requestId, input: STEP_SUMMARY_INPUT };
}

/**
 * Offer the button once the user has talked about this step in this round, unless the newest turn of the step
 * already is its summary: then the summary card is on screen and a second click would only pay for it again.
 */
export function offersStepSummary(turns: ReadonlyArray<{ input: string | null }>) {
  const latest = turns.at(-1);
  return Boolean(latest) && !isStepSummaryInput(latest!.input) && turns.some(turn => !isOpeningInput(turn.input));
}
