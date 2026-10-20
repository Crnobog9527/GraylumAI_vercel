/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { MentorStepEnvelope } from "./mentor-turn";

export type Information = {
  status: "unknown" | "unclear" | "provisional" | "confirmed" | "deferred";
  nature: "fact" | "decision" | "hypothesis" | "unknown";
  value: string;
};
export type Item = {
  id: string;
  platform: string;
  account: string;
  title: string;
  brief: string;
  day: string;
};
export type ConfirmStepEnvelope = {
  phase: "information" | "save" | "confirm";
  questionId?: string;
  finishStep?: boolean;
  values: Record<string, Information>;
  editingSnapshot: string;
  information: {
    draftId: string;
    stepId: string;
    requestId: string;
    expectedVersion: number;
    values: Record<string, Information>;
  };
  save: {
    action: "save";
    projectId: string;
    roundId: string;
    requestId: string;
    stepId: string;
    expectedVersion: number | null;
    body: string;
    evidenceIds: string[];
  };
  confirm: {
    action: "confirm";
    projectId: string;
    roundId: string;
    requestId: string;
    stepId: string;
    expectedVersion: number | null;
    expectedReviewVersion: number | null;
  };
};

export type StepEnvelope = MentorStepEnvelope<ConfirmStepEnvelope["information"]>;
export type ConfirmEnvelopeState =
  | { kind: "none" }
  | { kind: "valid"; envelope: ConfirmStepEnvelope; raw: string }
  | { kind: "malformed"; raw: string };
const confirmPhases: readonly string[] = ["information", "save", "confirm"];
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
/**
 * A pre-upgrade envelope has the same core fields as the current shape.
 * questionId/finishStep are optional, so a legacy envelope stays valid.
 */
export function isConfirmStepEnvelope(value: unknown): value is ConfirmStepEnvelope {
  if (!isRecord(value) || typeof value.phase !== "string" || !confirmPhases.includes(value.phase)) return false;
  if (
    !isRecord(value.values) ||
    !isRecord(value.information) ||
    !isRecord(value.save) ||
    !isRecord(value.confirm)
  )
    return false;
  return (
    typeof value.information.draftId === "string" &&
    typeof value.information.stepId === "string" &&
    typeof value.information.requestId === "string" &&
    typeof value.information.expectedVersion === "number" &&
    value.save.action === "save" &&
    typeof value.save.requestId === "string" &&
    value.confirm.action === "confirm" &&
    typeof value.confirm.requestId === "string"
  );
}
