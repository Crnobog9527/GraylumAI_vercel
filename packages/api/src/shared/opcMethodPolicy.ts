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
 * The published Skill revision is the only authority for this role. It declares
 * the optional `elicitation` property per information field, which the shared
 * `informationSchema` validates at publication and the read path preserves. A
 * revision that predates the property keeps working and resolves conservatively
 * to `user_fact`.
 *
 * Nothing here is inferred from a field's id, title, step number or position: a
 * field named `position` or `offer` is a user fact unless its own revision says
 * otherwise.
 */
export type Elicitation = "user_fact" | "agent_proposal";
export type MethodInformationField = {
  id: string;
  title?: string;
  required?: boolean;
  elicitation?: Elicitation;
};
/** A revision that does not declare the role means the user owns the fact. */
export const DEFAULT_ELICITATION: Elicitation = "user_fact";
/** The field's own declaration decides; anything else is the conservative default. */
export function fieldElicitation(field: MethodInformationField | null | undefined): Elicitation {
  return field?.elicitation === "agent_proposal" ? "agent_proposal" : DEFAULT_ELICITATION;
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
