/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

export type MentorSuggestion = {
  value: string;
  status: "unclear" | "provisional";
  nature: "fact" | "decision" | "hypothesis" | "unknown";
};

export type MentorResponse = {
  message: string;
  informationPatch: Record<string, MentorSuggestion>;
};

const natures = new Set(["fact", "decision", "hypothesis", "unknown"]);

/**
 * Mentor output is untrusted model text. Only the narrow public projection below
 * may reach the form; unknown fields, confirmation states and oversized values
 * are ignored. Plain-text output remains readable for older saved executions.
 */
export function readMentorResponse(
  raw: string | null | undefined,
  allowedFieldIds: ReadonlySet<string>,
): MentorResponse {
  if (!raw) return { message: "", informationPatch: {} };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid response");
    const message =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim().slice(0, 4000)
        : raw;
    const candidate =
      parsed.informationPatch &&
      typeof parsed.informationPatch === "object" &&
      !Array.isArray(parsed.informationPatch)
        ? (parsed.informationPatch as Record<string, unknown>)
        : {};
    const informationPatch: Record<string, MentorSuggestion> = {};
    for (const [fieldId, item] of Object.entries(candidate)) {
      if (
        !allowedFieldIds.has(fieldId) ||
        !item ||
        typeof item !== "object" ||
        Array.isArray(item)
      )
        continue;
      const value = (item as Record<string, unknown>).value;
      const nature = (item as Record<string, unknown>).nature;
      const status = (item as Record<string, unknown>).status;
      if (
        typeof value !== "string" ||
        !value.trim() ||
        value.length > 400 ||
        typeof nature !== "string" ||
        !natures.has(nature)
      )
        continue;
      informationPatch[fieldId] = {
        value: value.trim(),
        // A model may propose or flag uncertainty. It never confirms or defers
        // information on the user's behalf, even if its raw JSON says it did.
        status: status === "unclear" ? "unclear" : "provisional",
        nature: nature as MentorSuggestion["nature"],
      };
    }
    return { message, informationPatch };
  } catch {
    return { message: raw, informationPatch: {} };
  }
}

/** The model can suggest a target, never invent a step or authorize a write. */
export function readWorkflowMentorResponse(
  raw: string | null | undefined,
  originalStepId: string,
  fields: Record<string, { schema: Array<{ id: string }> }>,
) {
  let targetStepId = originalStepId;
  let invalidTarget = false;
  try {
    const parsed = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object" && Object.hasOwn(parsed, "targetStepId")) {
      const target = parsed.targetStepId;
      if (typeof target === "string" && Object.hasOwn(fields, target)) targetStepId = target;
      else invalidTarget = true;
    }
  } catch { /* Legacy plain text remains readable. */ }
  return {
    ...readMentorResponse(raw, new Set(invalidTarget ? [] : (fields[targetStepId]?.schema ?? []).map(f => f.id))),
    targetStepId,
  };
}
