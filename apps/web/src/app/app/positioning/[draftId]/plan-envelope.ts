/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * The retained plan-generation envelope is the only thing that authorizes an
 * automatic first-week plan generation. It freezes the exact request so a
 * refresh, a re-login or a lost reply replays the same identity instead of
 * paying twice. `sourceRoundId` is client recovery metadata only: the request
 * itself stays the strict server shape.
 */
export type PlanRequest = {
  draftId: string;
  requestId: string;
  purpose: "plan";
  stepId: string;
  input: string;
};
/**
 * `consentedAt` records the user's explicit "继续生成第一周选题" choice. It is
 * the only thing that authorizes an automatic first-week topic generation: an
 * envelope without it (a pre-upgrade `v:2`, or a bare legacy request) stays
 * recoverable with its own identity, but is never dispatched on its own.
 */
export type PlanEnvelope = { v: 3; sourceRoundId: string | null; consentedAt: string; request: PlanRequest };
type RetainedPlan =
  | { kind: "envelope"; envelope: PlanEnvelope }
  | { kind: "unconsented"; request: PlanRequest; sourceRoundId: string | null }
  | { kind: "legacy"; request: PlanRequest }
  | { kind: "invalid" };
function planRequestShape(value: unknown): PlanRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.draftId !== "string" ||
    typeof candidate.requestId !== "string" ||
    candidate.purpose !== "plan" ||
    typeof candidate.stepId !== "string" ||
    typeof candidate.input !== "string"
  )
    return null;
  return candidate as unknown as PlanRequest;
}
/**
 * Read the retained value defensively. A pre-upgrade value stored the bare
 * request; it is kept and reused by an explicit generation, but it carries no
 * `sourceRoundId`, so it can never authorize an automatic one. Malformed data
 * is reported as invalid instead of being reinterpreted.
 */
export function readPlanEnvelope(raw: string | null): RetainedPlan | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (parsed && typeof parsed === "object" && "request" in parsed) {
    const request = planRequestShape((parsed as { request: unknown }).request);
    if (!request) return { kind: "invalid" };
    const round = (parsed as { sourceRoundId?: unknown }).sourceRoundId;
    const consentedAt = (parsed as { consentedAt?: unknown }).consentedAt;
    const sourceRoundId = typeof round === "string" ? round : null;
    // Only an envelope that recorded the user's explicit consent may run by
    // itself. Anything else keeps its identity for an explicit continue.
    if (typeof consentedAt !== "string" || !consentedAt)
      return { kind: "unconsented", request, sourceRoundId };
    return {
      kind: "envelope",
      envelope: { v: 3, sourceRoundId, consentedAt, request },
    };
  }
  const legacy = planRequestShape(parsed);
  return legacy ? { kind: "legacy", request: legacy } : { kind: "invalid" };
}
