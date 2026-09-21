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

/**
 * How the mentor classified the user's turn. This is the model's contextual
 * judgement, not a keyword list: an acknowledgement may accept a concrete
 * proposal, an uncertainty is never an answer, and a request for help asks the
 * Agent to propose rather than to record what the user said.
 */
export type MentorInputKind =
  | "answer"
  | "acknowledgement"
  | "uncertainty"
  | "request"
  | "revision_request";
export type MentorBasis = "user_statement" | "agent_proposal";
export type MentorPatchEntry = MentorSuggestion & { basis: MentorBasis };
export type MentorTurn = {
  message: string;
  inputKind: MentorInputKind;
  informationPatch: Record<string, MentorPatchEntry>;
  targetStepId: string | null;
};

const natures = new Set(["fact", "decision", "hypothesis", "unknown"]);
const inputKinds = new Set<MentorInputKind>([
  "answer",
  "acknowledgement",
  "uncertainty",
  "request",
  "revision_request",
]);
/** Missing classification stays permissive so already saved replies keep working. */
const DEFAULT_INPUT_KIND: MentorInputKind = "answer";

function normalizeUtterance(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, " ")
    .replace(/[。.!！?？,，、~～…]+$/u, "")
    .trim();
}

/**
 * Mentor output is untrusted model text. Only the narrow public projection below
 * may reach the form; unknown fields, confirmation states and oversized values
 * are ignored. Plain-text output remains readable for older saved executions.
 */
export function readMentorTurn(
  raw: string | null | undefined,
  allowedFieldIds: ReadonlySet<string>,
): MentorTurn {
  if (!raw) return { message: "", inputKind: DEFAULT_INPUT_KIND, informationPatch: {}, targetStepId: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid response");
    const message =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim().slice(0, 4000)
        : raw;
    const inputKind =
      typeof parsed.inputKind === "string" && inputKinds.has(parsed.inputKind as MentorInputKind)
        ? (parsed.inputKind as MentorInputKind)
        : DEFAULT_INPUT_KIND;
    const candidate =
      parsed.informationPatch &&
      typeof parsed.informationPatch === "object" &&
      !Array.isArray(parsed.informationPatch)
        ? (parsed.informationPatch as Record<string, unknown>)
        : {};
    const informationPatch: Record<string, MentorPatchEntry> = {};
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
      const basis = (item as Record<string, unknown>).basis;
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
        basis: basis === "agent_proposal" ? "agent_proposal" : "user_statement",
      };
    }
    const target = parsed.targetStepId;
    return {
      message,
      inputKind,
      informationPatch,
      targetStepId: typeof target === "string" && target ? target : null,
    };
  } catch {
    return { message: raw, inputKind: DEFAULT_INPUT_KIND, informationPatch: {}, targetStepId: null };
  }
}

/**
 * Host-side enforcement. A non-substantive user turn must not become business
 * content merely because the model returned a non-empty patch for it:
 *
 * - an uncertainty never yields an answer;
 * - an acknowledgement or a request for help may accept an existing Agent
 *   proposal, but the utterance itself is dropped;
 * - a patch that merely echoes a non-answer utterance is dropped even if it was
 *   mislabelled as a grounded proposal.
 */
export function applyMentorTurnRules(
  turn: MentorTurn,
  userInput: string,
): Record<string, MentorPatchEntry> {
  const entries = Object.entries(turn.informationPatch);
  if (turn.inputKind === "uncertainty") return {};
  const proposalOnly =
    turn.inputKind === "acknowledgement" || turn.inputKind === "request";
  const echo = turn.inputKind === "answer" ? "" : normalizeUtterance(userInput);
  const patch: Record<string, MentorPatchEntry> = {};
  for (const [fieldId, entry] of entries) {
    if (proposalOnly && entry.basis !== "agent_proposal") continue;
    if (echo && normalizeUtterance(entry.value) === echo) continue;
    patch[fieldId] = entry;
  }
  return patch;
}

/** Legacy projection: message plus suggestions, without the turn classification. */
export function readMentorResponse(
  raw: string | null | undefined,
  allowedFieldIds: ReadonlySet<string>,
): MentorResponse {
  const turn = readMentorTurn(raw, allowedFieldIds);
  return {
    message: turn.message,
    informationPatch: Object.fromEntries(
      Object.entries(turn.informationPatch).map(([fieldId, entry]) => [
        fieldId,
        { value: entry.value, status: entry.status, nature: entry.nature },
      ]),
    ),
  };
}

/** A declared target must name an existing step; anything else is refused. */
function resolveTargetStep(
  raw: string | null | undefined,
  originalStepId: string,
  fields: Record<string, { schema: Array<{ id: string }> }>,
) {
  let targetStepId = originalStepId;
  let invalidTarget = false;
  try {
    const parsed = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object" && Object.hasOwn(parsed, "targetStepId")) {
      const target = (parsed as { targetStepId?: unknown }).targetStepId;
      if (typeof target === "string" && Object.hasOwn(fields, target)) targetStepId = target;
      else invalidTarget = true;
    }
  } catch {
    /* Legacy plain text remains readable. */
  }
  return {
    targetStepId,
    allowed: new Set(invalidTarget ? [] : (fields[targetStepId]?.schema ?? []).map(f => f.id)),
  };
}

/** The model can suggest a target, never invent a step or authorize a write. */
export function readWorkflowMentorResponse(
  raw: string | null | undefined,
  originalStepId: string,
  fields: Record<string, { schema: Array<{ id: string }> }>,
) {
  const { targetStepId, allowed } = resolveTargetStep(raw, originalStepId, fields);
  const turn = readMentorTurn(raw, allowed);
  return {
    message: turn.message,
    informationPatch: Object.fromEntries(
      Object.entries(turn.informationPatch).map(([fieldId, entry]) => [
        fieldId,
        { value: entry.value, status: entry.status, nature: entry.nature },
      ]),
    ),
    targetStepId,
  };
}

/** The workflow-aware turn projection used by the positioning page. */
export function readWorkflowMentorTurn(
  raw: string | null | undefined,
  originalStepId: string,
  fields: Record<string, { schema: Array<{ id: string }> }>,
): Omit<MentorTurn, "targetStepId"> & { targetStepId: string } {
  const { targetStepId, allowed } = resolveTargetStep(raw, originalStepId, fields);
  return { ...readMentorTurn(raw, allowed), targetStepId };
}

/**
 * New mentor turns keep the public reply and the administrator-selected
 * extractor result separate. Older saved turns had one combined JSON object,
 * so the missing-extraction branch intentionally preserves that projection.
 */
export function readWorkflowMentorExecution(
  primary: string | null | undefined,
  extraction: string | null | undefined,
  originalStepId: string,
  fields: Record<string, { schema: Array<{ id: string }> }>,
): Omit<MentorTurn, "targetStepId"> & { targetStepId: string } {
  if (!extraction) return readWorkflowMentorTurn(primary, originalStepId, fields);
  const structured = readWorkflowMentorTurn(extraction, originalStepId, fields);
  const visible = readMentorTurn(primary, new Set());
  return { ...structured, message: visible.message };
}
