/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * How the host elicits one declared information field.
 *
 * - `user_fact`: only the user owns this fact (their own experience, goal,
 *   resource or constraint). The mentor asks an easy, concrete question.
 * - `agent_proposal`: this field is a deliverable (naming, positioning,
 *   differentiation, content, operations, monetization). The Agent produces a
 *   grounded proposal from what is already known and the user verifies, edits
 *   or defers it. A beginner is never required to author the analysis.
 *
 * The property is an optional, backward-compatible extension of the published
 * method's information schema. An older revision or an already saved draft
 * simply has no `elicitation` and keeps working.
 */
export type Elicitation = "user_fact" | "agent_proposal";
export type MethodInformationField = {
  id: string;
  title?: string;
  required?: boolean;
  elicitation?: Elicitation;
};
/**
 * Declared elicitation for the currently published positioning method, keyed by
 * the method's own field id. This is versioned method configuration, not a
 * "step number >= N" rule: it is data, it is applied per field, and any field
 * absent from this table is treated as a user-owned fact.
 *
 * The declared method revision is the one already published for the
 * six-step positioning workflow (需求确认 → 对标账号分析 → 账号定位 →
 * 内容规划 → 运营建议 → 商业变现路径规划). Publishing a revision that
 * declares `elicitation` in its own information schema takes precedence.
 */
export const POSITIONING_METHOD_ELICITATION: Readonly<Record<string, Elicitation>> = Object.freeze({
  // Step 1 — 需求确认: the user's own situation, goals and constraints.
  niche: "user_fact",
  supply: "user_fact",
  audience: "user_fact",
  short_goal: "user_fact",
  long_goal: "user_fact",
  constraints: "user_fact",
  // Step 2 — 对标账号分析: the user supplies examples; the Agent analyses them.
  benchmarks: "user_fact",
  research_limits: "user_fact",
  opportunity: "agent_proposal",
  // Step 3 — 账号定位: Agent deliverables the user verifies.
  names: "agent_proposal",
  position: "agent_proposal",
  value: "agent_proposal",
  difference: "agent_proposal",
  precise_audience: "agent_proposal",
  priority: "agent_proposal",
  feasibility: "agent_proposal",
  // Step 4 — 内容规划.
  formats: "agent_proposal",
  pillars: "agent_proposal",
  style: "agent_proposal",
  cadence: "agent_proposal",
  topics: "agent_proposal",
  content_test: "agent_proposal",
  // Step 5 — 运营建议.
  segments: "agent_proposal",
  interaction: "agent_proposal",
  community: "agent_proposal",
  operations: "agent_proposal",
  // Step 6 — 商业变现路径规划.
  routes: "agent_proposal",
  offer: "agent_proposal",
  economics: "agent_proposal",
  timeline: "agent_proposal",
});
export const DEFAULT_ELICITATION: Elicitation = "user_fact";
/** A published declaration always wins; otherwise the versioned table applies. */
export function fieldElicitation(field: MethodInformationField | null | undefined): Elicitation {
  if (field?.elicitation === "user_fact" || field?.elicitation === "agent_proposal")
    return field.elicitation;
  return POSITIONING_METHOD_ELICITATION[field?.id ?? ""] ?? DEFAULT_ELICITATION;
}
export function isAgentProposal(field: MethodInformationField | null | undefined) {
  return fieldElicitation(field) === "agent_proposal";
}
/** Only the declared fields of the viewed step are ever sent to the model. */
export function elicitFieldSpecs(
  schema: readonly MethodInformationField[],
): Array<{ id: string; title: string; required: boolean; elicit: Elicitation }> {
  return schema.map(field => ({
    id: field.id,
    title: field.title ?? field.id,
    required: Boolean(field.required),
    elicit: fieldElicitation(field),
  }));
}
