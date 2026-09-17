"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { mergeInformation } from "./information-merge";
import { readWorkflowMentorResponse } from "./mentor-response";
import { confirmQuestionValues, displayedQuestion, nextInformationQuestion, questionIsConfirmed, reachedQuestions } from "@repo/api/src/shared/opcQuestions";
type Step = { id: string; title: string };
type Information = {
  status: "unknown" | "unclear" | "provisional" | "confirmed" | "deferred";
  nature: "fact" | "decision" | "hypothesis" | "unknown";
  value: string;
};
type Item = {
  id: string;
  platform: string;
  account: string;
  title: string;
  brief: string;
  day: string;
};
type ConfirmStepEnvelope = {
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

function isDefiniteConfirmConflict(cause: unknown) {
  return (
    cause instanceof Error &&
    [
      "OPC_INFORMATION_CONFLICT",
      "ARTIFACT_VERSION_CONFLICT",
      "ARTIFACT_REVIEW_REQUIRED",
    ].some((code) => cause.message.includes(code))
  );
}
type MentorRequest = {
  draftId: string;
  stepId: string;
  purpose: "mentor";
  requestId: string;
  input: string;
  questionId?: string;
};
type StepEnvelope = {
  request: MentorRequest;
  information?: ConfirmStepEnvelope["information"];
  editingSnapshot?: string;
};
type ConfirmEnvelopeState =
  | { kind: "none" }
  | { kind: "valid"; envelope: ConfirmStepEnvelope; raw: string }
  | { kind: "malformed"; raw: string };
const confirmPhases: readonly string[] = ["information", "save", "confirm"];
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
/**
 * A pre-upgrade envelope has the same core fields as the current shape.
 * questionId/finishStep are optional, so a legacy envelope stays valid.
 */
function isConfirmStepEnvelope(value: unknown): value is ConfirmStepEnvelope {
  if (!isRecord(value) || !confirmPhases.includes(value.phase)) return false;
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
/** The retained mentor request is either wrapped in `request` or legacy top-level. */
function parseStepEnvelope(raw: string): StepEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const candidate = isRecord(parsed.request) ? parsed.request : parsed;
  if (
    typeof candidate.draftId !== "string" ||
    typeof candidate.stepId !== "string" ||
    typeof candidate.requestId !== "string" ||
    typeof candidate.input !== "string"
  )
    return null;
  return {
    request: candidate as MentorRequest,
    information: isRecord(parsed.information)
      ? (parsed.information as ConfirmStepEnvelope["information"])
      : undefined,
    editingSnapshot:
      typeof parsed.editingSnapshot === "string"
        ? parsed.editingSnapshot
        : undefined,
  };
}
export default function PositioningDraft({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const { draftId } = use(params);
  const router = useRouter();
  const planView = usePathname().endsWith("/plan");
  const utils = trpc.useUtils();
  const read = trpc.opc.read.useQuery({ draftId });
  const list = trpc.opc.list.useQuery();
  const prepareStep = trpc.opc.prepareStep.useMutation(),
    execute = trpc.runtime.execute.useMutation();
  const information = trpc.opc.information.useMutation();
  const [infoEdits, setInfoEdits] = useState<
    Record<string, Record<string, Information>>
  >({});
  const revise = trpc.opc.revise.useMutation();
  const change = trpc.workbench.execute.useMutation(),
    savePlan = trpc.opc.savePlan.useMutation(),
    handoff = trpc.opc.handoff.useMutation();
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<Item[]>([]),
    [dirtyPlan, setDirtyPlan] = useState(false),
    [planCandidate, setPlanCandidate] = useState<Item[] | null>(null),
    [error, setError] = useState("");
  const history = trpc.runtime.view.useQuery(
    { sessionId: read.data?.sessionId ?? "" },
    { enabled: Boolean(read.data?.sessionId) },
  );
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [activeQuestions, setActiveQuestions] = useState<Record<string, string>>({});
  const [confirmingQuestion, setConfirmingQuestion] = useState(false);
  const confirmationLock = useRef(false);
  const chatScroll = useRef<HTMLDivElement>(null);
  const [mentorInput, setMentorInput] = useState("");
  const [hydratedDraft, setHydratedDraft] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    Record<string, "idle" | "saving" | "saved" | "error">
  >({});
  const [informationConflicts, setInformationConflicts] = useState<Record<string, { current: Record<string, Information>; fields: string[] }>>({});
  const infoEditsRef = useRef(infoEdits);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveChain = useRef<Promise<void>>(Promise.resolve());
  const appliedMentor = useRef(new Set<string>());
  const composing = useRef(false);
  const hasUnsavedInformation = Object.keys(infoEdits).length > 0;
  const d = read.data,
    snap = d?.snapshot,
    latest = d?.plans?.[0];
  const busy =
    running || confirmingQuestion ||
    revise.isPending ||
    prepareStep.isPending ||
    execute.isPending ||
    change.isPending ||
    savePlan.isPending ||
    handoff.isPending;
  useEffect(() => {
    // Hydrate before persisting: initial/StrictMode effects must not overwrite
    // a saved buffer with the render's empty initial state.
    let local: Record<string, any> = {};
    try {
      const raw = sessionStorage.getItem("opc-edit:" + draftId);
      if (raw) local = JSON.parse(raw) ?? {};
    } catch {
      /* Ignore a malformed local buffer. */
    }
    const restoredActiveStep =
      typeof local.activeStep === "string" ? local.activeStep : null;
    const legacyMentorInputs =
      local.mentorInputs && typeof local.mentorInputs === "object"
        ? (local.mentorInputs as Record<string, string>)
        : {};
    setActiveStep(restoredActiveStep);
    setActiveQuestions(local.activeQuestions ?? {});
    setMentorInput(
      typeof local.mentorInput === "string"
        ? local.mentorInput
        : (restoredActiveStep &&
              typeof legacyMentorInputs[restoredActiveStep] === "string"
            ? legacyMentorInputs[restoredActiveStep]
            : Object.values(legacyMentorInputs).find(
                (value) => typeof value === "string" && value.trim(),
              )) ?? "",
    );
    setInfoEdits(local.infoEdits ?? {});
    setPlanCandidate(
      Array.isArray(local.planCandidate) ? local.planCandidate : null,
    );
    setDirtyPlan(Boolean(local.dirtyPlan));
    setItems(local.dirtyPlan && Array.isArray(local.items) ? local.items : []);
    setHydratedDraft(draftId);
  }, [draftId]);
  useEffect(() => {
    if (hydratedDraft !== draftId) return;
    sessionStorage.setItem(
      "opc-edit:" + draftId,
      JSON.stringify({
        items,
        dirtyPlan,
        infoEdits,
        planCandidate,
        activeStep,
        activeQuestions,
        mentorInput,
      }),
    );
    const warn = (e: BeforeUnloadEvent) => {
      if (
        Object.keys(infoEdits).length ||
        dirtyPlan
      )
        e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [
    draftId,
    hydratedDraft,
    items,
    dirtyPlan,
    infoEdits,
    planCandidate,
    activeStep,
    activeQuestions,
    mentorInput,
  ]);
  useEffect(() => {
    infoEditsRef.current = infoEdits;
  }, [infoEdits]);
  useEffect(() => {
    if (hydratedDraft === draftId && !dirtyPlan && latest?.body)
      setItems(latest.body);
  }, [draftId, hydratedDraft, latest?.planId, dirtyPlan]);
  useEffect(() => {
    if (hydratedDraft !== draftId || activeStep || !snap) return;
    const initial =
      snap.workflow.steps.find((step: Step) => !snap.steps[step.id].valid) ??
      snap.workflow.steps[0];
    setActiveStep(initial.id);
  }, [draftId, hydratedDraft, activeStep, snap]);
  useEffect(() => {
    if (chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
  }, [history.data]);
  function captureInformationBase(stepId: string) {
    const key = "opc-information-base:" + draftId + ":" + stepId;
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify(d.information[stepId].values ?? {}));
  }
  async function persistInformation(
    stepId: string,
    requestedValues: Record<string, Information>,
  ) {
    const storageKey = "opc-information-autosave:" + draftId + ":" + stepId;
    // A queued task may outlive the edit that scheduled it.
    if (!infoEditsRef.current[stepId] && !sessionStorage.getItem(storageKey)) return;
    let wanted = infoEditsRef.current[stepId] ?? requestedValues;
    let retriedConflict = false;
    setSaveState((old) => ({ ...old, [stepId]: "saving" }));
    try {
      for (;;) {
        let fixed: {
          draftId: string;
          stepId: string;
          requestId: string;
          expectedVersion: number;
          values: Record<string, Information>;
          editingSnapshot: string;
        } | null = null;
        try {
          const raw = sessionStorage.getItem(storageKey);
          if (raw) fixed = JSON.parse(raw);
        } catch {
          throw new Error("OPC_AUTOSAVE_IDENTITY_UNREADABLE");
        }
        if (!fixed) {
          const current = (await read.refetch()).data;
          if (!current) throw new Error("OPC_UNAVAILABLE");
          const rawBase = sessionStorage.getItem("opc-information-base:" + draftId + ":" + stepId);
          if (!rawBase) {
            setInformationConflicts(old=>({...old,[stepId]:{current:current.information[stepId].values ?? {},fields:Object.keys(wanted)}}));
            throw new Error("OPC_EDIT_BASE_MISSING");
          }
          const merged = mergeInformation(JSON.parse(rawBase), wanted, current.information[stepId].values ?? {});
          if (merged.conflicts.length) {
            setInformationConflicts(old=>({...old,[stepId]:{current:current.information[stepId].values ?? {},fields:merged.conflicts}}));
            throw new Error("OPC_FIELD_CONFLICT:" + merged.conflicts.join(","));
          }
          fixed = {
            draftId,
            stepId,
            requestId: crypto.randomUUID(),
            expectedVersion: current.snapshot.steps[stepId].version,
            values: merged.values as Record<string, Information>,
            editingSnapshot: JSON.stringify(wanted),
          };
          sessionStorage.setItem(storageKey, JSON.stringify(fixed));
        }
        try {
          const { editingSnapshot: _editingSnapshot, ...request } = fixed;
          await information.mutateAsync(request);
        } catch (cause) {
          if (
            !retriedConflict &&
            cause instanceof Error &&
            cause.message.includes("OPC_INFORMATION_CONFLICT")
          ) {
            // A version conflict is a definite rollback. Refresh and create a
            // new identity once; ambiguous failures retain the original ID.
            retriedConflict = true;
            sessionStorage.removeItem(storageKey);
            await read.refetch();
            continue;
          }
          throw cause;
        }
        sessionStorage.removeItem(storageKey);
        await read.refetch();
        const latestValues = infoEditsRef.current[stepId];
        const hasLaterEdit = latestValues && JSON.stringify(latestValues) !== fixed.editingSnapshot;
        if (!hasLaterEdit) {
          infoEditsRef.current = { ...infoEditsRef.current };
          delete infoEditsRef.current[stepId];
          setInfoEdits(infoEditsRef.current);
          sessionStorage.removeItem("opc-information-base:" + draftId + ":" + stepId);
          break;
        }
        // Only edits made after this immutable request become the next request.
        const pending = mergeInformation(JSON.parse(fixed.editingSnapshot), latestValues, fixed.values);
        if (pending.conflicts.length) throw new Error("OPC_FIELD_CONFLICT:" + pending.conflicts.join(","));
        wanted = pending.values as Record<string, Information>;
        sessionStorage.setItem("opc-information-base:" + draftId + ":" + stepId, JSON.stringify(fixed.values));
        infoEditsRef.current = { ...infoEditsRef.current, [stepId]: wanted };
        setInfoEdits(infoEditsRef.current);
        retriedConflict = false;
      }
      setSaveState((old) => ({ ...old, [stepId]: "saved" }));
    } catch (cause) {
      setSaveState((old) => ({ ...old, [stepId]: "error" }));
      if (cause instanceof Error && /OPC_FIELD_CONFLICT|OPC_EDIT_BASE_MISSING/.test(cause.message)) {
        setError("其他窗口修改了相同信息。你的输入仍保留，请核对后再保存，未覆盖服务器内容。");
      }
      throw cause;
    }
  }
  function enqueueInformation(
    stepId: string,
    values: Record<string, Information>,
  ) {
    const task = autosaveChain.current.then(() =>
      persistInformation(stepId, values),
    );
    autosaveChain.current = task.catch(() => undefined);
    return task;
  }
  async function flushInformation(stepId: string) {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    const values = infoEditsRef.current[stepId];
    if (values) await enqueueInformation(stepId, values);
    else await autosaveChain.current;
  }
  useEffect(() => {
    if (hydratedDraft !== draftId || composing.current) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const pending = Object.entries(infoEdits).filter(([stepId]) => !sessionStorage.getItem("opc-confirm-step:" + draftId + ":" + stepId));
    if (!pending.length) return;
    autosaveTimer.current = setTimeout(() => {
      for (const [stepId, values] of pending)
        void enqueueInformation(stepId, values).catch(() => {
          setError("自动保存暂时失败。内容仍保留在本机，可重试保存。");
        });
    }, 700);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [draftId, hydratedDraft, infoEdits]);
  useEffect(() => {
    if (!d || !history.data) return;
    const executions = history.data.executions ?? [];
    for (const execution of executions as Array<{
      executionId: string;
      state: string;
      body: string | null;
      primaryBody: string | null;
    }>) {
      if (
        execution.state !== "completed" ||
        appliedMentor.current.has(execution.executionId)
      )
        continue;
      const turn = d.turns?.find(
        (item: { executionId: string; stepId: string; kind: string }) =>
          item.executionId === execution.executionId && item.kind === "mentor",
      );
      if (!turn) continue;
      const schema = d.information[turn.stepId]?.schema ?? [];
      const rawResponse = execution.body ?? execution.primaryBody;
      // A completed execution can become visible before its public result
      // projection is readable. Do not consume that identity until the result
      // exists, otherwise a later refresh can show the mentor reply without
      // ever applying its form suggestions.
      if (!rawResponse) continue;
      const parsed = readWorkflowMentorResponse(rawResponse, turn.stepId, d.information);
      appliedMentor.current.add(execution.executionId);
      if (!Object.keys(parsed.informationPatch).length || parsed.targetStepId !== turn.stepId ||
          d.snapshot.state !== "draft" || d.snapshot.steps[turn.stepId].valid) continue;
      setInfoEdits((old) => {
        const values = Object.fromEntries(
          schema.map((field: { id: string }) => [
            field.id,
            old[turn.stepId]?.[field.id] ??
              d.information[turn.stepId].values?.[field.id] ?? {
                status: "unknown",
                nature: "unknown",
                value: "",
              },
          ]),
        ) as Record<string, Information>;
        let changed = false;
        for (const [fieldId, suggestion] of Object.entries(
          parsed.informationPatch,
        )) {
          // A late response for a different question cannot fill an unseen field.
          if (fieldId !== displayedQuestion(schema, d.information[turn.stepId].values, activeQuestions[turn.stepId])?.id || values[fieldId]?.value.trim()) continue;
          values[fieldId] = suggestion;
          changed = true;
        }
        if (!changed) return old;
        captureInformationBase(turn.stepId);
        const next = { ...old, [turn.stepId]: values };
        // Autosave reads the ref inside a queued async task. Keep it in sync
        // with this mentor projection immediately instead of waiting for the
        // follow-up effect, otherwise a fast save can persist the previous
        // question's unknown value while the input already shows the mentor
        // suggestion.
        infoEditsRef.current = next;
        return next;
      });
    }
  }, [d, history.data, activeQuestions]);
  async function run(fn: () => Promise<unknown>) {
    setRunning(true);
    setError("");
    try {
      await fn();
      await read.refetch();
      await list.refetch();
      await history.refetch();
    } catch {
      setError(
        "操作未完成或版本已变化。编辑已保留；请重新读取状态，确认当前版本后再操作。",
      );
    } finally {
      setRunning(false);
    }
  }
  function stepEnvelopeFor(
    stepId: string,
  ): { raw: string; parsed: StepEnvelope | null } | null {
    if (hydratedDraft !== draftId || typeof window === "undefined") return null;
    const raw = sessionStorage.getItem("opc-step:" + draftId + ":" + stepId);
    return raw ? { raw, parsed: parseStepEnvelope(raw) } : null;
  }
  async function resumeStepEnvelope(step: Step, fixed: StepEnvelope) {
    const key = "opc-step:" + draftId + ":" + step.id;
    // Finish a request retained by the previous UI using its original
    // identities before accepting a newer message.
    if (fixed.information) {
      await information.mutateAsync(fixed.information);
      setInfoEdits(old => {
        if (JSON.stringify(old[step.id] ?? null) !== fixed.editingSnapshot) return old;
        const next = {...old}; delete next[step.id]; infoEditsRef.current = next; return next;
      });
    }
    // Resume the retained request without changing its identity.
    const request = fixed.request;
    if (request.questionId)
      setActiveQuestions((old) => ({ ...old, [step.id]: request.questionId! }));
    if (!request.input?.trim()) throw new Error("OPC_INPUT_REQUIRED");
    const admitted = await prepareStep.mutateAsync(request);
    await execute.mutateAsync({ executionId: admitted.executionId });
    // Pull the completed mentor execution while this request still owns the
    // current question identity. The generic post-action refresh below also
    // refreshes history, but read/list updates can re-render the query first;
    // relying on that later refetch left a completed mentor result invisible
    // to the form projection until a manual reload.
    await history.refetch();
    sessionStorage.removeItem(key);
    // A newer typed message is not overwritten; only an exact match is cleared.
    setMentorInput((old) => (old.trim() === request.input.trim() ? "" : old));
  }
  async function ask(step: Step, questionId: string) {
    const key = "opc-step:" + draftId + ":" + step.id;
    if (sessionStorage.getItem(key)) {
      // A retained envelope still owns this step. Never create a second
      // identity; the explicit recovery control resumes the original request.
      setError("上一条发给导师的内容仍在核对。请先用“继续核对这条原请求”恢复，不会重复发送。");
      return;
    }
    await run(async () => {
      await flushInformation(step.id);
      const fixed: StepEnvelope = {
        request: {
          draftId, stepId: step.id, purpose: "mentor", requestId: crypto.randomUUID(),
          input: mentorInput.trim(), questionId,
        },
      };
      sessionStorage.setItem(key, JSON.stringify(fixed));
      await resumeStepEnvelope(step, fixed);
    });
  }
  async function recoverStep(step: Step) {
    const key = "opc-step:" + draftId + ":" + step.id;
    const envelope = stepEnvelopeFor(step.id);
    if (!envelope) return;
    if (!envelope.parsed) {
      // An unreadable envelope cannot be resumed. Keep its raw value as
      // evidence, read server state first, then release the step.
      setRunning(true);
      setError("");
      try {
        sessionStorage.setItem("opc-step-archive:" + draftId + ":" + step.id, envelope.raw);
        const result = await read.refetch();
        if (result.error || !result.data) throw new Error("OPC_UNAVAILABLE");
        sessionStorage.removeItem(key);
        await history.refetch();
      } catch {
        setError("恢复未完成。原始请求仍保留在本机，未发送新请求。");
      } finally {
        setRunning(false);
      }
      return;
    }
    await run(async () => {
      await resumeStepEnvelope(step, envelope.parsed!);
    });
    // A mismatch or unknown outcome retains the original identity for a later
    // explicit retry instead of orphaning the request.
    if (sessionStorage.getItem(key))
      setError("原请求仍未确认结果，已继续保留。请稍后再试“继续核对这条原请求”，不会重复发送或重复扣费。");
  }
  function confirmEnvelopeState(stepId: string): ConfirmEnvelopeState {
    if (hydratedDraft !== draftId || typeof window === "undefined")
      return { kind: "none" };
    const raw = sessionStorage.getItem("opc-confirm-step:" + draftId + ":" + stepId);
    if (!raw) return { kind: "none" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "malformed", raw };
    }
    return isConfirmStepEnvelope(parsed)
      ? { kind: "valid", envelope: parsed, raw }
      : { kind: "malformed", raw };
  }
  function pendingConfirmationFor(stepId: string): ConfirmStepEnvelope | null {
    const state = confirmEnvelopeState(stepId);
    return state.kind === "valid" ? state.envelope : null;
  }
  function confirmationRedundant(stepId: string, questionId: string) {
    // A pending envelope is a recovery, never a duplicate; server validity must
    // not disable it. Otherwise an unchanged confirmed answer needs no rewrite.
    if (confirmEnvelopeState(stepId).kind !== "none") return false;
    return !infoEdits[stepId] && questionIsConfirmed(d.information[stepId].values?.[questionId]) &&
      (Boolean(nextInformationQuestion(d.information[stepId].schema, d.information[stepId].values)) || snap.steps[stepId].valid);
  }
  async function recoverCorruptConfirmation(stepId: string) {
    const state = confirmEnvelopeState(stepId);
    if (state.kind !== "malformed") return;
    setRunning(true);
    setError("");
    try {
      // Retain the unreadable value as evidence before touching the pending key.
      sessionStorage.setItem("opc-confirm-step-archive:" + draftId + ":" + stepId, state.raw);
      // Read server state first; only then allow re-checking the question.
      const result = await read.refetch();
      if (result.error || !result.data) throw new Error("OPC_UNAVAILABLE");
      sessionStorage.removeItem("opc-confirm-step:" + draftId + ":" + stepId);
      await history.refetch();
    } catch {
      setError("恢复未完成。原始确认记录已保留在本机，请稍后重试。");
    } finally {
      setRunning(false);
    }
  }
  function sameInformation(a: Information | undefined, b: Information | undefined) {
    return a?.value === b?.value && a?.status === b?.status && a?.nature === b?.nature;
  }
  async function confirmStep(step: Step, stepIndex: number, questionId: string, defer = false) {
    if (confirmationLock.current) return;
    const envelopeState = confirmEnvelopeState(step.id);
    if (envelopeState.kind === "malformed") {
      setError("上次的确认记录无法读取，结果未知。请先用“恢复上次确认记录并重新读取”保留原始内容，再重新核对本题。");
      return;
    }
    if (
      envelopeState.kind === "none" &&
      !infoEditsRef.current[step.id] &&
      questionIsConfirmed(d.information[step.id].values?.[questionId]) &&
      (Boolean(nextInformationQuestion(d.information[step.id].schema, d.information[step.id].values)) || snap.steps[step.id].valid)
    ) {
      // The stored answer is already confirmed and unchanged. Re-running the
      // save/confirm phases would be a duplicate write, so do nothing.
      setError("");
      return;
    }
    confirmationLock.current = true;
    setConfirmingQuestion(true);
    setError("");
    setActiveQuestions(old => ({ ...old, [step.id]: questionId }));
    const key = "opc-confirm-step:" + draftId + ":" + step.id;
    try {
      let fixed: ConfirmStepEnvelope | null = envelopeState.kind === "valid" ? envelopeState.envelope : null;
      if (!fixed) {
        // Confirm the answer the user actually saw, never a newer remote value.
        const viewed = infoEditsRef.current[step.id]?.[questionId] ?? d.information[step.id].values?.[questionId];
        await flushInformation(step.id);
        const result = await read.refetch();
        if (result.error || !result.data) throw new Error("OPC_UNAVAILABLE");
        const current = result.data;
        const schema = current.information[step.id].schema;
        const savedValue = current.information[step.id].values?.[questionId];
        if ((viewed?.value ?? "") !== (savedValue?.value ?? "") || infoEditsRef.current[step.id])
          throw new Error("OPC_INFORMATION_CONFLICT");
        const { values, finishStep } = confirmQuestionValues(schema, current.information[step.id].values ?? {}, questionId, defer);
        const body = schema.filter((field: {id:string}) => values[field.id].value).map((field: {id:string;title:string}) =>
          `${field.title}\n${values[field.id].status === "deferred" ? "（暂缓确认）" : ""}${values[field.id].value}`).join("\n\n");
        fixed = {
          phase: "information", questionId, finishStep, values,
          editingSnapshot: JSON.stringify(infoEditsRef.current[step.id] ?? null),
          information: {draftId,stepId:step.id,requestId:crypto.randomUUID(),expectedVersion:current.snapshot.steps[step.id].version,values},
          save: {action:"save",projectId:current.projectId,roundId:current.roundId,requestId:crypto.randomUUID(),stepId:step.id,expectedVersion:null,body,evidenceIds:current.snapshot.steps[step.id].evidenceIds},
          confirm: {action:"confirm",projectId:current.projectId,roundId:current.roundId,requestId:crypto.randomUUID(),stepId:step.id,expectedVersion:null,expectedReviewVersion:null},
        };
        sessionStorage.setItem(key, JSON.stringify(fixed));
      }
      const request = fixed;
      await run(async () => {
        try {
          if (request.phase === "information") {
            await information.mutateAsync(request.information);
            request.phase = "save";
            sessionStorage.setItem(key, JSON.stringify(request));
            setInfoEdits(old => {
              if (JSON.stringify(old[step.id] ?? null) !== request.editingSnapshot) return old;
              const next = {...old}; delete next[step.id]; infoEditsRef.current = next; return next;
            });
          }
          // Mid-step confirmation saves only this question. The final question
          // reuses the original step-result save/confirm identities, with no AI pass.
          if (request.finishStep !== false && request.phase === "save") {
            if (request.save.expectedVersion === null) {
              const result = await read.refetch();
              if (result.error || !result.data) throw new Error("OPC_UNAVAILABLE");
              const current = result.data;
              if (Object.keys(request.values).some(id => !sameInformation(current.information[step.id].values[id], request.values[id])))
                throw new Error("OPC_INFORMATION_CONFLICT");
              request.save.expectedVersion = current.snapshot.steps[step.id].version;
              request.save.evidenceIds = current.snapshot.steps[step.id].evidenceIds;
              sessionStorage.setItem(key, JSON.stringify(request));
            }
            await change.mutateAsync({...request.save,expectedVersion:request.save.expectedVersion!});
            request.phase = "confirm";
            sessionStorage.setItem(key, JSON.stringify(request));
          }
          if (request.finishStep !== false && request.phase === "confirm") {
            if (request.confirm.expectedVersion === null) {
              const result = await read.refetch();
              if (result.error || !result.data) throw new Error("OPC_UNAVAILABLE");
              const current = result.data, state = current.snapshot.steps[step.id];
              if (state.body !== request.save.body || Object.keys(request.values).some(id => !sameInformation(current.information[step.id].values[id], request.values[id])))
                throw new Error("OPC_INFORMATION_CONFLICT");
              request.confirm.expectedVersion = state.version;
              request.confirm.expectedReviewVersion = state.reviewVersion;
              sessionStorage.setItem(key, JSON.stringify(request));
            }
            await change.mutateAsync({...request.confirm,expectedVersion:request.confirm.expectedVersion!,expectedReviewVersion:request.confirm.expectedReviewVersion!});
          }
          const result = await read.refetch();
          if (result.error || !result.data) throw new Error("OPC_UNAVAILABLE");
          sessionStorage.removeItem(key);
          const current = result.data.information[step.id];
          const next = nextInformationQuestion(current.schema, current.values);
          setActiveQuestions(old => ({...old,[step.id]:next?.id ?? questionId}));
          if (request.finishStep !== false && result.data.snapshot.steps[step.id].valid && stepIndex < snap.workflow.steps.length - 1)
            setActiveStep(snap.workflow.steps[stepIndex + 1].id);
        } catch (cause) {
          if (isDefiniteConfirmConflict(cause)) {
            sessionStorage.removeItem(key);
            await read.refetch();
          }
          throw cause;
        }
      });
    } catch (cause) {
      setError(cause instanceof Error && cause.message.includes("OPC_QUESTION_ANSWER_REQUIRED")
        ? "请先补充当前问题的答案；暂时无法确定时，请写明原因后再暂缓确认。"
        : "操作未完成或信息已变化。你的输入仍保留，请先核对自动保存与当前答案后重试确认。");
    } finally {
      confirmationLock.current = false;
      setConfirmingQuestion(false);
    }
  }
  function update(index: number, key: keyof Item, value: string) {
    setItems((old) =>
      old.map((item, n) => (n === index ? { ...item, [key]: value } : item)),
    );
    setDirtyPlan(true);
  }
  async function generatePlan() {
    await run(async () => {
      if (hasUnsavedInformation) throw new Error("save information first");
      const accountInput = items.length
        ? JSON.stringify(
            items.map((i) => ({
              platform: i.platform,
              account: i.account,
              day: i.day,
            })),
          )
        : "";
      if (!accountInput) throw new Error("add concrete accounts first");
      const key = "opc-plan-generation:" + draftId;
      const old = sessionStorage.getItem(key);
      const request = old
        ? JSON.parse(old)
        : {
            draftId,
            requestId: crypto.randomUUID(),
            purpose: "plan" as const,
            stepId: snap.workflow.steps.at(-1).id,
            input: accountInput,
          };
      sessionStorage.setItem(key, JSON.stringify(request));
      const prepared = await prepareStep.mutateAsync(request);
      await execute.mutateAsync({ executionId: prepared.executionId });
      const candidate = await utils.opc.planResult.fetch({
        draftId,
        executionId: prepared.executionId,
      });
      if (!candidate.valid) {
        // This execution completed and returned a body that cannot be used as
        // a plan. It is safe to create a new request after the user edits the
        // inputs; timeouts and unknown execution state retain identity.
        sessionStorage.removeItem(key);
        throw new Error("OPC_PLAN_RESPONSE_INVALID");
      }
      setPlanCandidate(candidate.body);
      sessionStorage.removeItem(key);
    });
  }
  async function confirmPlan() {
    await run(async () => {
      if (
        !latest ||
        dirtyPlan ||
        hasUnsavedInformation
      )
        throw new Error("save edits first");
      const accounts = Array.from(
        new Map(
          items.map((i) => [
            i.platform + ":" + i.account,
            {
              platform: i.platform,
              account: i.account,
              expectedRevision:
                list.data?.accounts?.find(
                  (a: {
                    platform: string;
                    account: string;
                    revision: number;
                  }) => a.platform === i.platform && a.account === i.account,
                )?.revision ?? null,
            },
          ]),
        ).values(),
      );
      const payload = { draftId, planId: latest.planId, accounts };
      const key = "opc-confirm:" + draftId;
      const previous = sessionStorage.getItem(key);
      const fixed = previous
        ? JSON.parse(previous)
        : { ...payload, requestId: crypto.randomUUID() };
      if (
        fixed.draftId !== payload.draftId ||
        fixed.planId !== payload.planId ||
        JSON.stringify(
          fixed.accounts
            .map((a: { platform: string; account: string }) => [
              a.platform,
              a.account,
            ])
            .sort(),
        ) !==
          JSON.stringify(
            payload.accounts.map((a) => [a.platform, a.account]).sort(),
          )
      )
        throw new Error("confirmation pending");
      sessionStorage.setItem(key, JSON.stringify(fixed));
      try {
        await handoff.mutateAsync(fixed);
      } catch (cause) {
        // This specific SQL rejection rolls the entire transaction back. An old
        // expected account revision cannot become valid again (monotonic).
        // Timeouts, lost replies and all other errors retain the original request.
        if (cause instanceof Error && cause.message === "OPC_ACCOUNT_CONFLICT") {
          sessionStorage.removeItem(key);
          await list.refetch();
        }
        throw cause;
      }
      sessionStorage.removeItem(key);
    });
  }
  async function acceptSuggestion(executionId: string, stepId: string, patch: Record<string, Information>) {
    await run(async () => {
      await flushInformation(stepId);
      // Recover any pre-upgrade immutable suggestion request before starting a new edit.
      const legacyKey = "opc-suggestion:" + draftId + ":" + executionId;
      const legacy = sessionStorage.getItem(legacyKey);
      if (legacy) {
        await information.mutateAsync(JSON.parse(legacy));
        sessionStorage.removeItem(legacyKey);
      } else {
        captureInformationBase(stepId);
        const values = {...d.information[stepId].values, ...patch};
        infoEditsRef.current = {...infoEditsRef.current,[stepId]:values};
        setInfoEdits(infoEditsRef.current);
        await enqueueInformation(stepId,values);
      }
      setActiveStep(stepId);
      setActiveQuestions(old => ({...old,[stepId]:Object.keys(patch)[0]}));
    });
  }
  function retainConflictingInput(stepId: string) {
    const conflict=informationConflicts[stepId];
    const edited=infoEditsRef.current[stepId];
    const baseRaw=sessionStorage.getItem("opc-information-base:"+draftId+":"+stepId);
    if (!conflict || !edited) return;
    const merged=mergeInformation(baseRaw ? JSON.parse(baseRaw) : {},edited,conflict.current);
    const values={...merged.values} as Record<string,Information>;
    for(const field of conflict.fields) values[field]=edited[field];
    // The user has compared these exact server values. Later changes still conflict.
    sessionStorage.setItem("opc-information-base:"+draftId+":"+stepId,JSON.stringify(conflict.current));
    infoEditsRef.current={...infoEditsRef.current,[stepId]:values};
    setInfoEdits(infoEditsRef.current);
    setInformationConflicts(old=>{const next={...old};delete next[stepId];return next;});
  }
  if (read.isLoading || hydratedDraft !== draftId) return <main className="p-6">正在恢复定位…</main>;
  if (read.error || !d)
    return (
      <main className="p-6" role="alert">
        无法读取这份定位，请检查登录和访问权限。
        <Link href="/positioning">返回定位列表</Link>
      </main>
    );
  const steps: Step[] = snap.workflow.steps;
  const firstPending = steps.findIndex((step) => !snap.steps[step.id].valid);
  const selectedStep =
    steps.find((step) => step.id === activeStep) ??
    steps[Math.max(0, firstPending)];
  type MentorTurn = {
    executionId: string;
    stepId: string;
    kind: string;
  };
  type MentorExecution = {
    executionId: string;
    input: string | null;
    body: string | null;
    primaryBody: string | null;
    state: string;
  };
  const mentorTurns = new Map<string, MentorTurn>(
    ((d.turns ?? []) as MentorTurn[])
      .filter((turn) => turn.kind === "mentor")
      .map((turn) => [turn.executionId, turn]),
  );
  const mentorExecutions = Array.from(
    new Map(
      ((history.data?.executions ?? []) as MentorExecution[])
        .filter((execution) => mentorTurns.has(execution.executionId))
        .map((execution) => [execution.executionId, execution]),
    ).values(),
  );
  const latestSuggestion = new Map<string, string>();
  for (const execution of mentorExecutions) {
    const turn = mentorTurns.get(execution.executionId);
    if (!turn || execution.state !== "completed") continue;
    const response = readWorkflowMentorResponse(execution.body ?? execution.primaryBody, turn.stepId, d.information);
    if (Object.keys(response.informationPatch).length) latestSuggestion.set(response.targetStepId, execution.executionId);
  }
  const hasPendingConfirmation = steps.some(step => Boolean(pendingConfirmationFor(step.id)));
  // A retained mentor envelope can exist before its execution is visible in
  // history (or after a lost reply), so recovery is driven by the envelope
  // itself rather than the execution list.
  const pendingStepRequests = steps
    .map((step) => {
      const envelope = stepEnvelopeFor(step.id);
      return envelope ? { step, ...envelope } : null;
    })
    .filter((entry): entry is { step: Step; raw: string; parsed: StepEnvelope | null } => Boolean(entry));
  const hasPendingStepRequest = pendingStepRequests.length > 0;
  const pendingMentor = mentorExecutions.find(
    (execution) => !["completed", "cancelled"].includes(execution.state),
  );
  return (
    <main className="mx-auto max-w-[90rem] space-y-4 p-4 sm:p-6 text-[var(--text-primary)]">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{planView ? "第一周计划" : "与导师确定定位"}</h1>
          <p className="text-xs text-[var(--text-secondary)]">{d?.runtimeMode==='staging_test'?'Staging 真实模型测试 · 未开放联网研究':'隔离模拟 · 未调用真实模型或研究服务'}</p>
        </div>
        <Link href="/positioning" className="underline">
          账号与定位列表
        </Link>
      </header>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={() => read.refetch()}>
          重新读取状态
        </Button>
      </div>
      {!planView && <>{hasPendingStepRequest && (
        <section role="status" aria-label="待恢复的导师请求" className="space-y-2 rounded-xl border border-[var(--border-primary)] p-3">
          <p>有一条发给导师的内容结果尚未确认。原始请求已保留；恢复前不会发送新请求、确认步骤或切换步骤。</p>
          {pendingStepRequests.map(({ step, parsed }) => (
            <div key={step.id} className="space-y-2">
              <p className="text-sm">
                {step.title}：{parsed
                  ? "将用原来的问题和请求继续核对，不会重复发送或重复扣费。"
                  : "原请求无法读取。将先保留原始记录，再读取服务器状态。"}
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setActiveStep(step.id);
                  void recoverStep(step);
                }}
              >
                {parsed ? "继续核对这条原请求" : "保留原始记录并重新读取状态"}
              </Button>
            </div>
          ))}
        </section>
      )}
      <nav aria-label="定位步骤" className="flex gap-2 overflow-x-auto pb-1">
        {steps.map((step, index) => (
          <Button
            key={step.id}
            variant={selectedStep.id === step.id ? "default" : "outline"}
            aria-current={selectedStep.id === step.id ? "step" : undefined}
            disabled={
              busy || hasPendingConfirmation || hasPendingStepRequest ||
              (firstPending >= 0 &&
                index > firstPending &&
                !snap.steps[step.id].valid)
            }
            onClick={() => setActiveStep(step.id)}
          >
            {index + 1}. {step.title}
            {snap.steps[step.id].valid ? " · 已确认" : ""}
          </Button>
        ))}
      </nav>
      {hasUnsavedInformation && (
        <p role="status">
          正在保存最新修改。保存完成前不会确认步骤或采用计划。
        </p>
      )}
      <section aria-label="当前定位步骤" className="space-y-4">
        {snap.workflow.steps.map((step: Step, index: number) => {
          if (step.id !== selectedStep.id) return null;
          const s = snap.steps[step.id];
          const schema = d.information[step.id].schema as Array<{
            id: string;
            title: string;
            required: boolean;
          }>;
          const confirmationState = confirmEnvelopeState(step.id);
          const pendingConfirmation = pendingConfirmationFor(step.id);
          const activeQuestion = (pendingConfirmation?.questionId && schema.find(f => f.id === pendingConfirmation.questionId)) || displayedQuestion(schema, d.information[step.id].values, activeQuestions[step.id]);
          if (!activeQuestion) return null;
          const knownQuestions = reachedQuestions(schema, d.information[step.id].values);
          const questionConfirmed =
            questionIsConfirmed(d.information[step.id].values?.[activeQuestion.id]) &&
            !infoEdits[step.id];
          return (
            <article
              key="positioning-workspace"
              className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4"
            >
              <h2 className="text-lg">
                {index + 1}. {step.title} {s.valid ? "· 已确认" : "· 待确认"}
              </h2>
              <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(22rem,0.92fr)]">
                <aside
                  aria-label="全程导师聊天"
                  className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4 lg:sticky lg:top-4"
                >
                  <div>
                    <p className="text-xs text-[var(--text-secondary)]">全程同一对话</p>
                    <h3 className="font-semibold">
                      和导师一起，一次确认一个问题
                    </h3>
                  </div>
                  <div
                    ref={chatScroll}
                    role="log"
                    aria-label="完整导师消息"
                    aria-live="polite"
                    className="max-h-[55vh] min-h-56 space-y-3 overflow-y-auto overscroll-contain pr-2"
                  >
                    <div className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
                      <span className="text-xs text-[var(--text-secondary)]">导师</span>
                      <p className="mt-1 whitespace-pre-wrap break-words">
                        我会在同一个对话里陪你完成全部步骤，一次问一个问题，并把从回答中梳理出的信息放到右侧对应表单，供你核对。
                      </p>
                    </div>
                    {mentorExecutions.map((execution) => {
                      const turn = mentorTurns.get(execution.executionId);
                      const turnStep = steps.find(
                        (candidate) => candidate.id === turn?.stepId,
                      );
                      const parsed = readWorkflowMentorResponse(execution.body ?? execution.primaryBody, turn?.stepId ?? step.id, d.information);
                      const target = steps.find(candidate => candidate.id === parsed.targetStepId);
                      const proposed = Object.entries(parsed.informationPatch).filter(([id, value]) =>
                        reachedQuestions(d.information[parsed.targetStepId]?.schema ?? [], d.information[parsed.targetStepId]?.values).some(f => f.id === id) &&
                        value.value !== (infoEdits[parsed.targetStepId]?.[id] ?? d.information[parsed.targetStepId]?.values?.[id])?.value);
                      return (
                        <div key={execution.executionId} className="space-y-2">
                          <div className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
                            <span className="text-xs text-[var(--text-secondary)]">
                              你{turnStep ? ` · ${turnStep.title}` : ""}
                            </span>
                            <p className="mt-1 whitespace-pre-wrap break-words">
                              {execution.input ?? "内容暂不可用"}
                            </p>
                          </div>
                          <div className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
                            <span className="text-xs text-[var(--text-secondary)]">
                              导师{turnStep ? ` · ${turnStep.title}` : ""}
                            </span>
                            <p className="mt-1 whitespace-pre-wrap break-words">
                              {parsed.message ||
                                (execution.state === "cancelled"
                                  ? "这条回复未发给模型，你可以直接重新描述问题。"
                                  : "这条回复还在核对原请求，不会重复发送或重复扣费。")}
                            </p>
                          </div>
                          {execution.state === "completed" && target && latestSuggestion.get(target.id) === execution.executionId && proposed.length > 0 && (
                            <div className="rounded border border-[var(--border-primary)] p-3">
                              <p>导师建议调整 · {target.title}</p>
                              {proposed.map(([id, value]) => <p key={id} className="text-sm">{d.information[target.id].schema.find((f: {id:string}) => f.id === id)?.title}：{value.value}</p>)}
                              <Button variant="outline" disabled={busy || hasPendingConfirmation || hasPendingStepRequest || Boolean(pendingMentor) || snap.state !== "draft"}
                                onClick={() => acceptSuggestion(execution.executionId, target.id, Object.fromEntries(proposed))}>采用这些修改到“{target.title}”</Button>
                              <p className="text-xs">原有内容在采用前保持不变。采用后请核对本步骤及受影响的后续结果。</p>
                            </div>
                          )}
                          {!["completed", "cancelled"].includes(
                            execution.state,
                          ) && (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                run(() =>
                                  execute.mutateAsync({
                                    executionId: execution.executionId,
                                  }),
                                )
                              }
                            >
                              继续核对这条回复
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div aria-label="当前导师任务" role="status" className="rounded-xl bg-[var(--bg-tertiary)] p-3">
                    <p className="text-xs text-[var(--text-secondary)]">步骤引导 · {step.title}</p>
                    <p className="mt-1 text-sm">{s.valid ? "这一步已有结果已保留。" : `我们接下来一起完成“${step.title}”。`}现在只聊“{activeQuestion.title}”。你可以继续补充；核对后点击这道题下面的确认按钮，再进入下一题。</p>
                  </div>
                  <label className="block text-sm">
                    回复导师
                    <Textarea
                      className="resize-none"
                      aria-label="给导师的回复"
                      value={mentorInput}
                      disabled={busy || hasPendingConfirmation || hasPendingStepRequest || Boolean(pendingMentor) || snap.state !== "draft"}
                      onChange={(event) => setMentorInput(event.target.value)}
                      placeholder="用自己的话说就好，可以多聊几轮。"
                      maxLength={8000}
                    />
                  </label>
                  <Button
                    disabled={
                      busy ||
                      Boolean(pendingMentor) || hasPendingConfirmation || hasPendingStepRequest ||
                      snap.state !== "draft" ||
                      !mentorInput.trim()
                    }
                    onClick={() => ask(step, activeQuestion.id)}
                  >
                    {busy ? "正在回复…" : "发送"}
                  </Button>
                  <p className="text-xs text-[var(--text-secondary)]">
                    各步骤共用这一条对话记录。右侧每次只显示当前问题；确认后再继续，刷新或重新登录可恢复已保存进度。{d?.runtimeMode==='staging_test'?'当前使用真实模型，仅处理你提供的资料。':'当前为隔离模拟，不调用真实模型。'}
                  </p>
                </aside>
                <section
                  aria-label="本步填写信息"
                  className="space-y-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-[var(--text-secondary)]">当前问题</p>
                      <h3 className="font-semibold">逐题核对，确认后继续</h3>
                    </div>
                    <p role="status" className="text-xs text-[var(--text-secondary)]">
                      {saveState[step.id] === "saving"
                        ? "正在自动保存…"
                        : saveState[step.id] === "error"
                          ? "自动保存失败"
                          : saveState[step.id] === "saved"
                            ? "已自动保存"
                            : "修改后自动保存"}
                    </p>
                  </div>
                  {questionConfirmed && (
                    <p role="status" className="text-sm">
                      已确认当前问题「{activeQuestion.title}」
                      {s.valid ? `；本步骤「${step.title}」已确认，无需重复确认。` : "。继续修改后可重新确认。"}
                    </p>
                  )}
                  <p className="text-sm text-[var(--text-secondary)]">
                    你可以直接填写，也可以和左侧导师聊。填写与自动保存不等于确认；当前答案由你核对确认后，我们再进入下一个问题。
                  </p>
                  {informationConflicts[step.id] && <div role="alert">
                    <p>其他窗口修改了相同字段。你的输入未提交，请比较后决定。</p>
                    {informationConflicts[step.id].fields.map(id=><p key={id}>{schema.find(f=>f.id===id)?.title ?? id}：服务器「{informationConflicts[step.id].current[id]?.value ?? ""}」；你的输入「{infoEdits[step.id]?.[id]?.value ?? ""}」</p>)}
                    <Button onClick={()=>retainConflictingInput(step.id)}>保留我的这些修改并重新保存</Button>
                  </div>}
                  {confirmationState.kind === "malformed" && (
                    <div role="alert" className="space-y-2">
                      <p>上次的确认请求无法读取，确认结果未知。原始记录已在本机保留，不会被删除。恢复会先读取服务器状态，再允许你重新核对当前问题，不会当作已确认通过。</p>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void recoverCorruptConfirmation(step.id)}
                      >
                        恢复上次确认记录并重新读取
                      </Button>
                    </div>
                  )}
                  <div className="space-y-4">
                  {[activeQuestion].map((field) => {
                      const value = infoEdits[step.id]?.[field.id] ??
                        d.information[step.id].values?.[field.id] ?? {
                          status: "unknown",
                          nature: "unknown",
                          value: "",
                        };
                      function updateInfo(patch: Partial<Information>) {
                        captureInformationBase(step.id);
                        setInfoEdits((old) => ({
                          ...old,
                          [step.id]: {
                            ...Object.fromEntries(
                              d.information[step.id].schema.map(
                                (f: { id: string }) => [
                                  f.id,
                                  old[step.id]?.[f.id] ??
                                    d.information[step.id].values?.[f.id] ?? {
                                      status: "unknown",
                                      nature: "unknown",
                                      value: "",
                                    },
                                ],
                              ),
                            ),
                            [field.id]: { ...value, ...patch },
                          },
                        }));
                      }
                      return (
                        <div key={field.id} className="space-y-2">
                          <label className="block font-medium" htmlFor={`${step.id}-${field.id}`}>
                            {field.title}
                            {field.required ? "（必需）" : ""}
                          </label>
                          <Textarea
                            id={`${step.id}-${field.id}`}
                            aria-label={field.title}
                            maxLength={400}
                            className="min-h-20 resize-none"
                            disabled={busy || hasPendingConfirmation || hasPendingStepRequest || snap.state !== "draft"}
                            value={value.value}
                            onCompositionStart={() => {
                              composing.current = true;
                            }}
                            onCompositionEnd={() => {
                              composing.current = false;
                              const values = infoEditsRef.current[step.id];
                              if (values)
                                void enqueueInformation(step.id, values).catch(() =>
                                  setError("自动保存暂时失败。内容仍保留在本机，可重试保存。"),
                                );
                            }}
                            onChange={(event) =>
                              updateInfo({
                                value: event.target.value,
                                status: event.target.value.trim()
                                  ? "provisional"
                                  : "unknown",
                                nature:
                                  value.nature === "unknown"
                                    ? "decision"
                                    : value.nature,
                              })
                            }
                          />
                          {value.status === "provisional" && (
                            <p className="text-xs text-[var(--text-secondary)]">
                              答案已保存为待核对内容，请确认或继续修改。
                            </p>
                          )}
                          <Button className="w-full" disabled={busy || hasPendingStepRequest || snap.state !== "draft" || Boolean(pendingMentor) || confirmationState.kind === "malformed" || confirmationRedundant(step.id, field.id)} onClick={() => confirmStep(step, index, field.id)}>
                            {pendingConfirmation ? "继续核对本题确认" : "确认本题并继续"}
                          </Button>
                          <Button variant="outline" className="w-full" disabled={busy || hasPendingConfirmation || hasPendingStepRequest || snap.state !== "draft" || Boolean(pendingMentor) || confirmationState.kind === "malformed" || confirmationRedundant(step.id, field.id)} onClick={() => confirmStep(step, index, field.id, true)}>
                            {field.required ? "按填写的原因暂缓本题并继续" : "暂时跳过本题"}
                          </Button>
                          <p className="text-xs text-[var(--text-secondary)]">还没想清楚可以继续和导师聊。{field.required ? "暂缓时请在上方写明原因，不会记成已确认事实。" : "选填问题可以明确选择跳过。"}</p>
                          {pendingConfirmation && <p role="status">正在核对原确认请求。确认成功前保持本题，不会跳过下一题。</p>}

                        </div>
                      );
                    })}
                  </div>
                  {saveState[step.id] === "error" && (
                    <Button
                      variant="outline"
                      disabled={information.isPending || hasPendingConfirmation}
                      onClick={() => {
                        const values = infoEditsRef.current[step.id];
                        if (values)
                          void enqueueInformation(step.id, values).catch(() =>
                            setError("自动保存仍未成功。内容已保留，请稍后重试。"),
                          );
                      }}
                    >
                      重试自动保存
                    </Button>
                  )}
                  {(() => {
                    const pending = nextInformationQuestion(schema, d.information[step.id].values);
                    return pending && pending.id !== activeQuestion.id ? (
                      <Button variant="outline" className="w-full" disabled={busy || hasUnsavedInformation || hasPendingConfirmation || hasPendingStepRequest || Boolean(pendingMentor)}
                        onClick={() => setActiveQuestions(old => ({ ...old, [step.id]: pending.id }))}>
                        继续当前待确认问题
                      </Button>
                    ) : null;
                  })()}
                  {knownQuestions.some(field => field.id !== activeQuestion.id && questionIsConfirmed(d.information[step.id].values?.[field.id])) && (
                    <nav aria-label="已确认的问题" className="space-y-2 border-t border-[var(--border-primary)] pt-3">
                      <p className="text-xs text-[var(--text-secondary)]">回看已确认的内容</p>
                      {knownQuestions.filter(field => field.id !== activeQuestion.id && questionIsConfirmed(d.information[step.id].values?.[field.id])).map(field => (
                        <Button key={field.id} variant="outline" className="w-full justify-start whitespace-normal text-left" disabled={busy || hasPendingConfirmation || hasPendingStepRequest || Boolean(pendingMentor)} onClick={() => setActiveQuestions(old => ({...old,[step.id]:field.id}))}>
                          已确认 · {field.title} · 回看修改
                        </Button>
                      ))}
                    </nav>
                  )}
                </section>
              </div>
              {s.valid && index < steps.length - 1 && (
                <Button
                  disabled={busy || hasUnsavedInformation || hasPendingStepRequest}
                  onClick={() => setActiveStep(steps[index + 1].id)}
                >
                  继续下一步
                </Button>
              )}
            </article>
          );
        })}
      </section>
      </>}
      {!planView && snap.state === "published" && (
        <Button
          variant="outline"
          disabled={busy || dirtyPlan}
          onClick={() =>
            run(() =>
              revise.mutateAsync({
                draftId,
                requestId: crypto.randomUUID(),
                expectedRoundId: d.roundId,
              }),
            )
          }
        >
          修订定位，保留原版本
        </Button>
      )}
      {!planView && <Button
        disabled={
          busy ||
          hasUnsavedInformation ||
          hasPendingConfirmation || hasPendingStepRequest || steps.some((step) => !snap.steps[step.id].valid) ||
          snap.state !== "draft"
        }
        onClick={() =>
          run(async () => {
            await change.mutateAsync({
              action: "publish",
              projectId: d.projectId,
              roundId: d.roundId,
              requestId: crypto.randomUUID(),
              expectedSteps: Object.fromEntries(
                Object.entries(
                  snap.steps as Record<
                    string,
                    { version: number; reviewVersion: number }
                  >,
                ).map(([k, v]) => [
                  k,
                  { version: v.version, reviewVersion: v.reviewVersion },
                ]),
              ),
            });
            router.push(`/positioning/${draftId}/plan`);
          })
        }
      >
        确认正式定位版本
      </Button>}
      {!planView && d.report?.available && <Link className="block underline" href={`/positioning/${draftId}/plan`}>进入第一周计划</Link>}
      {planView && <Link className="block underline" href={`/positioning/${draftId}`}>返回定位与导师对话</Link>}
      {planView && !d.report?.available && <p role="status">请先确认正式定位，再制定第一周计划。原定位和对话仍保留。</p>}
      {planView && d.report?.available && <section aria-label="定位摘要" className="rounded-xl border border-[var(--border-primary)] p-4">
        <h2 className="text-xl">已确认的定位</h2>
        <dl className="grid gap-3 sm:grid-cols-2">{steps.flatMap(step => d.information[step.id].schema.map((field: {id:string;title:string}) =>
          <div key={step.id+":"+field.id}><dt className="text-sm text-[var(--text-secondary)]">{field.title}</dt><dd className="whitespace-pre-wrap">{d.information[step.id].values?.[field.id]?.value || "未填写"}</dd></div>))}</dl>
      </section>}
      {planView && d.report?.available && (
        <section className="space-y-4">
          <h2 className="text-xl">第一周计划</h2>
          <p>可编辑账号、日期和简报。确认承接不会调用模型或产生新的费用。</p>
          <div className="overflow-x-auto"><table aria-label="第一周选题计划" className="w-full text-left">
            <thead><tr>{["平台","具体账号","选题","日期","简报","操作"].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
            <tbody>{items.map((item, index) => (
            <tr key={item.id} className="border-t border-[var(--border-primary)]">
              {(["platform", "account", "title", "day"] as const).map((key) => (
                <td key={key} className="p-2">
                  <input
                    className="ml-2 rounded border bg-[var(--bg-secondary)] p-2"
                    aria-label={key + " " + index}
                    type={key === "day" ? "date" : "text"}
                    disabled={busy}
                    value={item[key]}
                    onChange={(e) => update(index, key, e.target.value)}
                  />
                  {key === "account" && <p className="text-xs text-[var(--text-secondary)]">{list.data?.accounts?.some((a: {platform:string;account:string}) => a.platform === item.platform && a.account === item.account) ? "已有账号 · 保留原工作项" : "待承接账号 · 确认后创建"}</p>}
                </td>
              ))}
              <td className="p-2">
                <Textarea aria-label="简报"
                  className="resize-none"
                  disabled={busy}
                  value={item.brief}
                  onChange={(e) => update(index, "brief", e.target.value)}
                />
              </td>
              <td className="p-2"><Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setItems((old) => old.filter((_, n) => n !== index));
                  setDirtyPlan(true);
                }}
              >
                删除选题
              </Button></td>
            </tr>
          ))}</tbody></table></div>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={
                busy ||
                hasUnsavedInformation ||
                !items.length ||
                items.some((i) => !i.account)
              }
              onClick={generatePlan}
            >
              按已保存账号生成计划候选
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setItems((old) => [
                  ...old,
                  {
                    id: crypto.randomUUID(),
                    platform: "x",
                    account: "",
                    title: "",
                    brief: "",
                    day: new Date().toISOString().slice(0, 10),
                  },
                ]);
                setDirtyPlan(true);
              }}
            >
              添加选题
            </Button>
            <Button
              disabled={
                busy || hasUnsavedInformation || !dirtyPlan || !items.length
              }
              onClick={() =>
                run(async () => {
                  if (hasUnsavedInformation)
                    throw new Error("save information first");
                  await savePlan.mutateAsync({
                    draftId,
                    requestId: crypto.randomUUID(),
                    expectedVersion: latest?.version ?? 0,
                    sourceVersionId: d.report.id,
                    body: items,
                  });
                  await read.refetch();
                  setDirtyPlan(false);
                })
              }
            >
              保存计划版本
            </Button>
          </div>
          {planCandidate && (
            <div className="space-y-3 rounded border border-[var(--border-primary)] p-4">
              <h3>AI 计划候选 · 尚未替换你的编辑</h3>
              {planCandidate.map((i) => (
                <p key={i.id}>
                  {i.day} · {i.platform}/{i.account} · {i.title}
                </p>
              ))}
              <Button
                disabled={busy}
                onClick={() => {
                  setItems(planCandidate);
                  setDirtyPlan(true);
                  setPlanCandidate(null);
                }}
              >
                采用候选到计划工作稿
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPlanCandidate(null)}
              >
                保留原计划
              </Button>
            </div>
          )}
          {latest && !dirtyPlan && (
            <div className="rounded-xl border border-[var(--border-primary)] p-4">
              <h3>确认采用定位与计划第 {latest.version} 版</h3>
              <p>
                将为以上具体账号创建选题；已有账号将采用当前定位，原有工作项保持原版本。
              </p>
              <Button
                disabled={
                  busy || hasUnsavedInformation
                }
                onClick={confirmPlan}
              >
                确认账号与计划，创建选题
              </Button>
            </div>
          )}
        </section>
      )}
      {planView && d.handoffs?.length > 0 && (
        <section>
          <h2 className="text-xl">已承接选题</h2>
          {d.handoffs
            .flatMap(
              (h: {
                result: Array<{ workItemId: string; sessionId: string }>;
              }) => h.result,
            )
            .map((i: { workItemId: string; sessionId: string }) => (
              <div key={i.workItemId}>
                <Link
                  className="underline"
                  href={"/runtime?session=" + i.sessionId}
                >
                  进入选题工作空间
                </Link>
              </div>
            ))}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
