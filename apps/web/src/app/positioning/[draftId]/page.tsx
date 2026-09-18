"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { mergeInformation } from "./information-merge";
import { applyMentorTurnRules, readWorkflowMentorTurn } from "./mentor-response";
import {
  confirmQuestionValues,
  displayedQuestion,
  isOpeningInput,
  nextInformationQuestion,
  OPENING_INPUT,
  openingEntryKey,
  openingRequestId,
  questionIsConfirmed,
  questionLabel,
  reachedQuestions,
} from "@repo/api/src/shared/opcQuestions";
import { isAgentProposal } from "@repo/api/src/shared/opcMethodPolicy";
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
/**
 * The retained plan-generation envelope is the only thing that authorizes an
 * automatic first-week plan generation. It freezes the exact request so a
 * refresh, a re-login or a lost reply replays the same identity instead of
 * paying twice. `sourceRoundId` is client recovery metadata only: the request
 * itself stays the strict server shape.
 */
type PlanRequest = {
  draftId: string;
  requestId: string;
  purpose: "plan";
  stepId: string;
  input: string;
};
type PlanEnvelope = { v: 2; sourceRoundId: string | null; request: PlanRequest };
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
function readPlanEnvelope(
  raw: string | null,
):
  | { kind: "envelope"; envelope: PlanEnvelope }
  | { kind: "legacy"; request: PlanRequest }
  | { kind: "invalid" }
  | null {
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
    return {
      kind: "envelope",
      envelope: {
        v: 2,
        sourceRoundId: typeof round === "string" ? round : null,
        request,
      },
    };
  }
  const legacy = planRequestShape(parsed);
  return legacy ? { kind: "legacy", request: legacy } : { kind: "invalid" };
}
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
    /**
     * The round that produced the local candidate. A candidate is only usable
     * when it names the round on screen, so a candidate left over from an
     * earlier round can neither be shown nor suppress a new one.
     */
    [planCandidateRound, setPlanCandidateRound] = useState<string | null>(null),
    [planCandidateRequest, setPlanCandidateRequest] = useState<string | null>(
      null,
    ),
    [error, setError] = useState("");
  /**
   * Plan generation needs the user's own choices only (platform, optional
   * account, start date, horizon). Topics, dates, titles and briefs are the
   * Agent's output, so no manually authored topic row is required.
   */
  const [planPlatform, setPlanPlatform] = useState("");
  const [planAccount, setPlanAccount] = useState("");
  const [planStart, setPlanStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [planDays, setPlanDays] = useState(7);
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
  /**
   * Automatic plan recovery is bounded twice: one attempt per retained request
   * id per page load, and one in-flight attempt at a time. A React effect must
   * never be able to turn into a loop of provider calls.
   */
  const planAutoRunning = useRef(false);
  const planAutoAttempts = useRef(new Set<string>());
  const [planRecovery, setPlanRecovery] = useState<
    "idle" | "running" | "invalid" | "unknown" | "stale"
  >("idle");
  const planEnvelopeKey = "opc-plan-generation:" + draftId;
  const hasUnsavedInformation = Object.keys(infoEdits).length > 0;
  const d = read.data,
    snap = d?.snapshot,
    latest = d?.plans?.[0];
  // `prepareStep`/`execute` are deliberately excluded: the Agent's own opening
  // uses them, and it must never disable the form the user is filling in. Every
  // user-initiated use of them runs inside `run()` (or a named flag), which is
  // what actually gates the controls.
  const busy =
    running || confirmingQuestion ||
    revise.isPending ||
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
    // A pre-upgrade buffer stored a bare candidate with no round, so it is
    // read as unowned rather than being assumed to belong to this round.
    setPlanCandidateRound(
      typeof local.planCandidateSourceRoundId === "string"
        ? local.planCandidateSourceRoundId
        : null,
    );
    setPlanCandidateRequest(
      typeof local.planCandidateRequestId === "string"
        ? local.planCandidateRequestId
        : null,
    );
    setDirtyPlan(Boolean(local.dirtyPlan));
    setItems(local.dirtyPlan && Array.isArray(local.items) ? local.items : []);
    setHydratedDraft(draftId);
  }, [draftId]);
  useEffect(() => {
    if (hydratedDraft !== draftId) return;
    try {
      // Merge rather than replace: the buffer also carries the candidate's
      // round ownership and any archive an earlier action left behind.
      const raw = sessionStorage.getItem("opc-edit:" + draftId);
      const previous = raw ? (JSON.parse(raw) ?? {}) : {};
      sessionStorage.setItem(
        "opc-edit:" + draftId,
        JSON.stringify({
          ...previous,
          items,
          dirtyPlan,
          infoEdits,
          planCandidate,
          planCandidateSourceRoundId: planCandidateRound,
          planCandidateRequestId: planCandidateRequest,
          activeStep,
          activeQuestions,
          mentorInput,
        }),
      );
    } catch {
      /* A malformed local buffer must not break persistence. */
    }
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
    planCandidateRound,
    planCandidateRequest,
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
  /**
   * Bounded automatic generation of the first-week plan candidate.
   *
   * It runs only for an envelope frozen by the final positioning confirmation
   * of the round currently on screen. Opening `/plan` for an older published
   * draft carries no such envelope, so waiting or refreshing there can never
   * call a model on its own.
   */
  useEffect(() => {
    if (!planView || hydratedDraft !== draftId) return;
    if (!d?.report?.available) return;
    // A candidate owned by this round is already waiting for the user's
    // decision; re-running would only re-read the same idempotent execution.
    // A candidate from another round must never suppress this one.
    if (candidateBelongsToCurrentRound()) return;
    if (planAutoRunning.current) return;
    const retained = readRetainedPlan();
    if (!retained) return;
    if (retained.kind === "invalid") {
      releasePlanEnvelope();
      setPlanRecovery("invalid");
      setNotice(
        "本机保存的计划生成记录无法读取，已停止自动生成。请手动点击生成；只有你确认后才会产生新的模型调用。",
      );
      return;
    }
    // No round binding: an explicit user action may reuse it, nothing else.
    if (retained.kind === "legacy") return;
    if (retained.envelope.request.draftId !== draftId) {
      archiveStalePlanEnvelope(
        "发现一条属于其它定位草稿的计划生成请求，已在本机归档。它不会被执行，也不会产生费用。",
      );
      return;
    }
    if (retained.envelope.sourceRoundId !== d.roundId) {
      archiveStalePlanEnvelope(
        "定位已修订，上一轮的计划生成请求已在本机归档，不会执行。请按当前定位重新生成计划候选。",
      );
      return;
    }
    const request = retained.envelope.request;
    if (planAutoAttempts.current.has(request.requestId)) return;
    planAutoAttempts.current.add(request.requestId);
    planAutoRunning.current = true;
    setPlanRecovery("running");
    void (async () => {
      try {
        const prepared = await prepareStep.mutateAsync(request);
        await execute.mutateAsync({ executionId: prepared.executionId });
        const candidate = await utils.opc.planResult.fetch({
          draftId,
          executionId: prepared.executionId,
        });
        if (!candidate.valid) {
          // A definite invalid result is terminal for this request: the
          // execution completed and its body can never become a plan.
          releasePlanEnvelope();
          setPlanRecovery("invalid");
          return;
        }
        persistPlanCandidate(
          candidate.body,
          retained.envelope.sourceRoundId,
          request.requestId,
        );
        setPlanRecovery("idle");
      } catch {
        // Timeout, lost reply or unknown outcome: the same envelope and request
        // id are retained, and replay is idempotent, so recovering cannot cost
        // a second call.
        setPlanRecovery("unknown");
      } finally {
        planAutoRunning.current = false;
      }
    })();
  }, [
    planView,
    hydratedDraft,
    draftId,
    d?.report?.available,
    d?.roundId,
    planCandidate,
    planCandidateRound,
  ]);
  useEffect(() => {
    if (chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
  }, [history.data]);
  function captureInformationBase(stepId: string) {
    const key = "opc-information-base:" + draftId + ":" + stepId;
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify(d.information[stepId].values ?? {}));
  }
  /**
   * The form keeps only the three public fields. The mentor's turn
   * classification (`inputKind`, `basis`) stays in the conversation and must
   * never travel into the persisted information payload.
   */
  function toInformation(entry: {
    value: string;
    status: string;
    nature: string;
  }): Information {
    return {
      value: entry.value,
      status: entry.status as Information["status"],
      nature: entry.nature as Information["nature"],
    };
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
      input: string | null;
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
          item.executionId === execution.executionId &&
          (item.kind === "mentor" || item.kind === "opening"),
      );
      if (!turn) continue;
      const schema = d.information[turn.stepId]?.schema ?? [];
      const rawResponse = execution.body ?? execution.primaryBody;
      // A completed execution can become visible before its public result
      // projection is readable. Do not consume that identity until the result
      // exists, otherwise a later refresh can show the mentor reply without
      // ever applying its form suggestions.
      if (!rawResponse) continue;
      const parsed = readWorkflowMentorTurn(rawResponse, turn.stepId, d.information);
      // A non-substantive user turn (an acknowledgement, an uncertainty or a
      // request for help) never becomes business content on its own.
      const accepted = applyMentorTurnRules(parsed, execution.input ?? "");
      appliedMentor.current.add(execution.executionId);
      if (!Object.keys(accepted).length || parsed.targetStepId !== turn.stepId ||
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
        for (const [fieldId, suggestion] of Object.entries(accepted)) {
          // A late response for a different question cannot fill an unseen field.
          if (fieldId !== displayedQuestion(schema, d.information[turn.stepId].values, activeQuestions[turn.stepId])?.id || values[fieldId]?.value.trim()) continue;
          values[fieldId] = toInformation(suggestion);
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
  /**
   * The Agent opens the current question itself, so a beginner is never asked to
   * send a placeholder like "你好" or "继续" first. This runs on first entry into
   * a question and again after a confirmation advances to the next one. The
   * request identity is derived from the entry, so a refresh, a re-login, a
   * second tab or a lost reply reuses the same turn instead of paying twice.
   */
  const autoOpening = useRef(new Set<string>());
  const openingInFlight = useRef(new Set<string>());
  const [openingSteps, setOpeningSteps] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (planView || hydratedDraft !== draftId || !d || !history.data) return;
    if (d.snapshot.state !== "draft") return;
    const flowSteps: Step[] = d.snapshot.workflow.steps;
    const firstPending = flowSteps.findIndex(step => !d.snapshot.steps[step.id].valid);
    const step =
      flowSteps.find(candidate => candidate.id === activeStep) ??
      flowSteps[Math.max(0, firstPending)];
    if (!step) return;
    const stepIndex = flowSteps.findIndex(candidate => candidate.id === step.id);
    // Only a step whose dependencies are confirmed can be opened: the current
    // pending step, or an already confirmed step being reviewed.
    if (!d.snapshot.steps[step.id].valid && stepIndex !== firstPending) return;
    const state = d.information[step.id];
    const question = displayedQuestion(state.schema, state.values, activeQuestions[step.id]);
    if (!question) return;
    // Reviewing a question that is already confirmed restores its content; it
    // does not generate another turn.
    if (questionIsConfirmed(state.values?.[question.id])) return;
    const turns = (d.turns ?? []) as Array<{
      stepId: string;
      questionId: string | null;
      roundId?: string | null;
      kind: string;
    }>;
    // One opening per round. A turn from an older round never suppresses the
    // current round's opening, and never gets reused for it: the round is part
    // of the request identity. A revision therefore produces a genuinely new
    // opening for the same step/question, while the older round's request keeps
    // its own identity and stays recoverable through its execution.
    // A projection without round ownership (a database that predates it) keeps
    // the previous round-blind behaviour instead of silently changing meaning.
    const sameRound = (turn: { roundId?: string | null }) =>
      !Object.hasOwn(turn, "roundId") || turn.roundId === d.roundId;
    if (turns.some(turn =>
      turn.stepId === step.id && turn.questionId === question.id &&
      sameRound(turn) &&
      (turn.kind === "mentor" || turn.kind === "opening")))
      return;
    // A retained explicit mentor request already owns this step's next turn.
    if (sessionStorage.getItem("opc-step:" + draftId + ":" + step.id)) return;
    if (sessionStorage.getItem("opc-confirm-step:" + draftId + ":" + step.id)) return;
    const key = openingEntryKey(draftId, d.roundId, step.id, question.id);
    if (autoOpening.current.has(key)) return;
    autoOpening.current.add(key);
    openingInFlight.current.add(step.id);
    setOpeningSteps([...openingInFlight.current]);
    void (async () => {
      try {
        sessionStorage.setItem(key, "pending");
        // Finish any opening an interrupted page left running before admitting
        // a new one: a busy session would refuse it, and the user's question
        // would stay unopened.
        await resumeInterruptedOpening();
        const admitted = await prepareStep.mutateAsync({
          draftId,
          stepId: step.id,
          purpose: "mentor",
          requestId: openingRequestId(draftId, d.roundId, step.id, question.id),
          input: OPENING_INPUT,
          questionId: question.id,
        });
        await execute.mutateAsync({ executionId: admitted.executionId });
        // The chat joins the execution history to opc.read's turn/question
        // bindings. Refresh both projections; history alone leaves a completed
        // opening invisible until an unrelated user action refreshes the draft.
        const [draftRead, historyRead] = await Promise.all([
          read.refetch(),
          history.refetch(),
        ]);
        if (draftRead.error || !draftRead.data || historyRead.error || !historyRead.data)
          throw new Error("OPC_OPENING_READBACK_UNAVAILABLE");
        sessionStorage.removeItem(key);
        setNotice("");
      } catch {
        // The Agent's opening is a convenience, never a gate on the form. The
        // entry identity is deterministic, so a later retry reuses the same
        // turn instead of producing a second one or a second charge.
        sessionStorage.removeItem(key);
        setNotice("导师引导这次没有加载成功。你可以直接填写右侧表单，或刷新后重试；不会重复生成或重复扣费。");
      } finally {
        openingInFlight.current.delete(step.id);
        setOpeningSteps([...openingInFlight.current]);
      }
    })();
  }, [planView, hydratedDraft, draftId, d, history.data, activeStep, activeQuestions]);
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
  function readRetainedPlan() {
    return readPlanEnvelope(sessionStorage.getItem(planEnvelopeKey));
  }
  /**
   * The candidate is written into the local buffer synchronously, before any
   * React state is relied on, so a reload cannot lose a candidate the user has
   * already paid for.
   */
  function persistPlanCandidate(
    candidate: Item[] | null,
    sourceRoundId: string | null,
    requestId: string | null,
  ) {
    try {
      const raw = sessionStorage.getItem("opc-edit:" + draftId);
      const local = raw ? (JSON.parse(raw) ?? {}) : {};
      const next: Record<string, unknown> = {
        ...local,
        planCandidateSourceRoundId: candidate ? sourceRoundId : null,
        planCandidateRequestId: candidate ? requestId : null,
      };
      if (candidate) next.planCandidate = candidate;
      else delete next.planCandidate;
      sessionStorage.setItem("opc-edit:" + draftId, JSON.stringify(next));
    } catch {
      /* A malformed local buffer must not block the candidate itself. */
    }
    setPlanCandidate(candidate);
    setPlanCandidateRound(candidate ? sourceRoundId : null);
    setPlanCandidateRequest(candidate ? requestId : null);
  }
  /**
   * Adopting or dismissing ends the candidate: its body, its round ownership
   * and the authorization that produced it go away together.
   */
  function clearPlanCandidate() {
    persistPlanCandidate(null, null, null);
  }
  /**
   * A revision starts a new round, so the previous round's candidate must stop
   * being current immediately. Its body is archived rather than destroyed.
   */
  function archivePlanCandidateForRevision() {
    try {
      const raw = sessionStorage.getItem("opc-edit:" + draftId);
      const local = raw ? (JSON.parse(raw) ?? {}) : {};
      if (Array.isArray(local.planCandidate))
        local.planCandidateArchive = {
          roundId:
            typeof local.planCandidateSourceRoundId === "string"
              ? local.planCandidateSourceRoundId
              : null,
          body: local.planCandidate,
        };
      delete local.planCandidate;
      delete local.planCandidateSourceRoundId;
      delete local.planCandidateRequestId;
      sessionStorage.setItem("opc-edit:" + draftId, JSON.stringify(local));
    } catch {
      /* The revision itself must not depend on the local buffer. */
    }
    setPlanCandidate(null);
    setPlanCandidateRound(null);
    setPlanCandidateRequest(null);
  }
  function releasePlanEnvelope() {
    sessionStorage.removeItem(planEnvelopeKey);
  }
  /**
   * A retained request that cannot belong to the round on screen is archived
   * verbatim, never migrated onto the new round, and never executed.
   */
  function archiveStalePlanEnvelope(message: string) {
    const raw = sessionStorage.getItem(planEnvelopeKey);
    if (raw)
      sessionStorage.setItem(planEnvelopeKey + ":stale:" + Date.now(), raw);
    sessionStorage.removeItem(planEnvelopeKey);
    setPlanRecovery("stale");
    setNotice(message);
  }
  /** True when the local candidate was produced by the round on screen. */
  function candidateBelongsToCurrentRound() {
    return Boolean(planCandidate) && planCandidateRound === d?.roundId;
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
  async function resumeInterruptedOpening() {
    // An Agent opening interrupted by a reload can still own the session's
    // active execution. Resume that same execution before creating a new turn:
    // a new admission would be refused while the session is busy, and the
    // user's own action would be lost. Resuming is idempotent.
    const interrupted = mentorExecutions.find(
      execution =>
        mentorTurns.get(execution.executionId)?.kind === "opening" &&
        !["completed", "cancelled"].includes(execution.state),
    );
    if (interrupted)
      await execute.mutateAsync({ executionId: interrupted.executionId });
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
      await resumeInterruptedOpening();
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
  async function confirmStep(step: Step, stepIndex: number, questionId: string, defer = false, nonAnswers: readonly string[] = []) {
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
        const { values, finishStep } = confirmQuestionValues(schema, current.information[step.id].values ?? {}, questionId, defer, { nonAnswers });
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
        : cause instanceof Error && cause.message.includes("OPC_QUESTION_ANSWER_NOT_SUBSTANTIVE")
          ? "「好的」「不知道」这类回应本身不是本题的业务答案。请确认导师给出的建议内容，或写下你自己的答案。"
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
  /**
   * The confirmed positioning the plan must be generated from. Only confirmed or
   * explicitly deferred information is included, and the payload stays inside
   * the host's input limit.
   */
  function positioningSummary() {
    if (!d) return {} as Record<string, string>;
    const summary: Record<string, string> = {};
    for (const step of snap.workflow.steps as Step[]) {
      for (const field of d.information[step.id]?.schema ?? []) {
        const answer = d.information[step.id]?.values?.[field.id];
        if (!answer?.value?.trim()) continue;
        if (!["confirmed", "deferred"].includes(answer.status)) continue;
        summary[field.title] = `${answer.value.trim().slice(0, 200)}${answer.status === "deferred" ? "（用户明确暂缓，接受局限）" : ""}`;
        if (JSON.stringify(summary).length > 5000) return summary;
      }
    }
    return summary;
  }
  async function generatePlan() {
    await run(async () => {
      await resumeInterruptedOpening();
      if (hasUnsavedInformation) throw new Error("save information first");
      // No manually authored topic row is required: the Agent produces the
      // topics, dates, titles and briefs. Only user-owned choices are supplied.
      const constraints = {
        confirmedPositioning: positioningSummary(),
        platforms: planPlatform.split(",").map(v => v.trim()).filter(Boolean),
        accounts: planAccount.split(",").map(v => v.trim()).filter(Boolean),
        startDate: planStart,
        days: planDays,
      };
      const accountInput = JSON.stringify(constraints);
      // A retained request may only be replayed when it is genuinely the same
      // intent: nothing is waiting for a decision, and the user's constraints
      // are unchanged. Anything else is a new explicit authorization.
      const retained = readRetainedPlan();
      const retainedRequest =
        retained?.kind === "envelope" &&
        retained.envelope.sourceRoundId === d.roundId &&
        retained.envelope.request.draftId === draftId
          ? retained.envelope.request
          : retained?.kind === "legacy" && retained.request.draftId === draftId
            ? retained.request
            : null;
      const reuse =
        retainedRequest &&
        !candidateBelongsToCurrentRound() &&
        retainedRequest.input === accountInput
          ? retainedRequest
          : null;
      const request: PlanRequest = reuse ?? {
        draftId,
        requestId: crypto.randomUUID(),
        purpose: "plan",
        stepId: snap.workflow.steps.at(-1).id,
        input: accountInput,
      };
      const envelope: PlanEnvelope = {
        v: 2,
        sourceRoundId: d.roundId,
        request,
      };
      sessionStorage.setItem(planEnvelopeKey, JSON.stringify(envelope));
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
        releasePlanEnvelope();
        setPlanRecovery("invalid");
        throw new Error("OPC_PLAN_RESPONSE_INVALID");
      }
      // The envelope is deliberately retained while the candidate waits for the
      // user's decision: that is what lets a reload or a re-login recover the
      // same execution instead of paying for another one.
      persistPlanCandidate(candidate.body, d.roundId, request.requestId);
      setPlanRecovery("idle");
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
  /**
   * Until a candidate has been adopted and while no plan version is saved, the
   * Agent produces the first proposal. Manual authoring stays available but
   * must not be presented as the primary path.
   */
  /**
   * Only a candidate that names the round on screen is shown as this round's
   * candidate. A pre-upgrade candidate has no owner at all, so it stays
   * reviewable but can never impersonate or suppress a round.
   */
  const shownPlanCandidate =
    Boolean(planCandidate) &&
    (planCandidateRound === null || planCandidateRound === d?.roundId)
      ? planCandidate
      : null;
  const planNeedsCandidate = !shownPlanCandidate && !latest && !dirtyPlan;
  const firstPending = steps.findIndex((step) => !snap.steps[step.id].valid);
  const selectedStep =
    steps.find((step) => step.id === activeStep) ??
    steps[Math.max(0, firstPending)];
  type MentorTurn = {
    executionId: string;
    stepId: string;
    questionId: string | null;
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
      .filter((turn) => turn.kind === "mentor" || turn.kind === "opening")
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
    const parsed = readWorkflowMentorTurn(execution.body ?? execution.primaryBody, turn.stepId, d.information);
    if (Object.keys(applyMentorTurnRules(parsed, execution.input ?? "")).length) latestSuggestion.set(parsed.targetStepId, execution.executionId);
  }
  /** Utterances the mentor classified as non-answers, per question. */
  const nonAnswersFor = (stepId: string, questionId: string) =>
    mentorExecutions
      .filter((execution) => {
        const turn = mentorTurns.get(execution.executionId);
        return turn?.stepId === stepId && turn?.questionId === questionId;
      })
      .map((execution) => {
        const parsed = readWorkflowMentorTurn(execution.body ?? execution.primaryBody, stepId, d.information);
        return parsed.inputKind === "answer" ? "" : execution.input ?? "";
      })
      .filter((value) => Boolean(value));
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
  // Only a user-initiated mentor turn gates the page. The Agent's own opening
  // is a convenience and must never block the form or the other controls.
  const pendingMentor = mentorExecutions.find(
    (execution) =>
      mentorTurns.get(execution.executionId)?.kind === "mentor" &&
      !["completed", "cancelled"].includes(execution.state),
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
            elicitation?: "user_fact" | "agent_proposal";
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
                      const turnIndex = steps.findIndex(candidate => candidate.id === turn?.stepId);
                      // A historical message keeps the question number it was
                      // asked under, even after the form has moved on.
                      const turnLabel = turnIndex >= 0
                        ? questionLabel(turnIndex, d.information[turn!.stepId]?.schema ?? [], turn?.questionId)
                        : null;
                      const parsed = readWorkflowMentorTurn(execution.body ?? execution.primaryBody, turn?.stepId ?? step.id, d.information);
                      const accepted = applyMentorTurnRules(parsed, execution.input ?? "");
                      const openingTurn = turn?.kind === "opening" || isOpeningInput(execution.input);
                      const target = steps.find(candidate => candidate.id === parsed.targetStepId);
                      const proposed = Object.entries(accepted).filter(([id, value]) =>
                        reachedQuestions(d.information[parsed.targetStepId]?.schema ?? [], d.information[parsed.targetStepId]?.values).some(f => f.id === id) &&
                        value.value !== (infoEdits[parsed.targetStepId]?.[id] ?? d.information[parsed.targetStepId]?.values?.[id])?.value);
                      return (
                        <div key={execution.executionId} className="space-y-2">
                          {/* The host opens the question itself: no fabricated user message. */}
                          {!openingTurn && (
                            <div className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
                              <span className="text-xs text-[var(--text-secondary)]">
                                你{turnLabel ? ` · ${turnLabel}` : turnStep ? ` · ${turnStep.title}` : ""}
                              </span>
                              <p className="mt-1 whitespace-pre-wrap break-words">
                                {execution.input ?? "内容暂不可用"}
                              </p>
                            </div>
                          )}
                          <div className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
                            <span className="text-xs text-[var(--text-secondary)]">
                              {openingTurn ? "导师主动引导" : "导师"}
                              {turnLabel ? ` · ${turnLabel}` : turnStep ? ` · ${turnStep.title}` : ""}
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
                                onClick={() => acceptSuggestion(execution.executionId, target.id, Object.fromEntries(proposed.map(([id, entry]) => [id, toInformation(entry)])))}>采用这些修改到“{target.title}”</Button>
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
                  {openingSteps.includes(step.id) && (
                    <p role="status" className="text-xs text-[var(--text-secondary)]">
                      导师正在准备这道题的引导，不需要你先发言；右侧表单现在就可以填写。
                    </p>
                  )}
                  <Button
                    disabled={
                      busy ||
                      openingSteps.includes(step.id) ||
                      Boolean(pendingMentor) || hasPendingConfirmation || hasPendingStepRequest ||
                      snap.state !== "draft" ||
                      !mentorInput.trim()
                    }
                    onClick={() => ask(step, activeQuestion.id)}
                  >
                    {busy ? "正在回复…" : "发送"}
                  </Button>
                  <p className="text-xs text-[var(--text-secondary)]">
                    导师会主动引导当前问题，不需要你先发“你好”或“继续”。各步骤共用这一条对话记录；右侧每次只显示当前问题，确认后再继续，刷新或重新登录可恢复已保存进度。{d?.runtimeMode==='staging_test'?'当前使用真实模型，仅处理你提供的资料。':'当前为隔离模拟，不调用真实模型。'}
                  </p>
                </aside>
                <section
                  aria-label="本步填写信息"
                  className="space-y-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-[var(--text-secondary)]">
                        当前问题 · {questionLabel(index, schema, activeQuestion.id)}
                      </p>
                      <h3 className="font-semibold">
                        {questionLabel(index, schema, activeQuestion.id)} {activeQuestion.title}
                        {activeQuestion.required ? "（必需）" : "（选填）"}
                      </h3>
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
                            {questionLabel(index, schema, field.id)} {field.title}
                            {field.required ? "（必需）" : ""}
                          </label>
                          <p className="text-xs text-[var(--text-secondary)]">
                            {isAgentProposal(field)
                              ? "这是导师要给出的成果建议：由导师根据已确认的资料先提出草案，你只需要核对、修改或确认，不需要自己从头写分析。"
                              : "这是你自己的事实：请按你的真实情况填写，导师不会替你编造。"}
                            {value.status === "provisional" && value.nature === "hypothesis"
                              ? " 当前内容为导师提出的待验证建议。"
                              : ""}
                          </p>
                          {value.value.trim() && (
                            <p className="text-xs text-[var(--text-secondary)]">
                              性质：
                              {value.nature === "fact" ? "已陈述事实"
                                : value.nature === "decision" ? "已作出的决定"
                                  : value.nature === "hypothesis" ? "待验证假设"
                                    : "尚未判断"}
                              {" · 状态："}
                              {value.status === "confirmed" ? "已确认"
                                : value.status === "deferred" ? "已明确暂缓（接受局限）"
                                  : value.status === "provisional" ? "待你核对"
                                    : value.status === "unclear" ? "尚不充分"
                                      : "尚未填写"}
                            </p>
                          )}
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
                          <Button className="w-full" disabled={busy || hasPendingStepRequest || snap.state !== "draft" || Boolean(pendingMentor) || confirmationState.kind === "malformed" || confirmationRedundant(step.id, field.id)} onClick={() => confirmStep(step, index, field.id, false, nonAnswersFor(step.id, field.id))}>
                            {pendingConfirmation ? "继续核对本题确认" : "确认本题并继续"}
                          </Button>
                          <Button variant="outline" className="w-full" disabled={busy || hasPendingConfirmation || hasPendingStepRequest || snap.state !== "draft" || Boolean(pendingMentor) || confirmationState.kind === "malformed" || confirmationRedundant(step.id, field.id)} onClick={() => confirmStep(step, index, field.id, true, nonAnswersFor(step.id, field.id))}>
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
            run(async () => {
              await revise.mutateAsync({
                draftId,
                requestId: crypto.randomUUID(),
                expectedRoundId: d.roundId,
              });
              // The revised round must not inherit the previous round's
              // candidate, locally or in the buffer.
              archivePlanCandidateForRevision();
            })
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
            // Freeze the future plan request from the confirmed information on
            // screen, before anything navigates.
            const request: PlanRequest = {
              draftId,
              requestId: crypto.randomUUID(),
              purpose: "plan",
              stepId: snap.workflow.steps.at(-1).id,
              input: JSON.stringify({
                confirmedPositioning: positioningSummary(),
                platforms: planPlatform
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
                accounts: planAccount
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
                startDate: planStart,
                days: planDays,
              }),
            };
            const sourceRoundId = d.roundId;
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
            // Only a successful publish authorizes the automatic generation,
            // and only for the round that was just published.
            const envelope: PlanEnvelope = { v: 2, sourceRoundId, request };
            sessionStorage.setItem(planEnvelopeKey, JSON.stringify(envelope));
            router.push(`/positioning/${draftId}/plan`);
          })
        }
      >
        确认正式定位并生成第一周计划
      </Button>}
      {!planView && (
        <p className="text-xs text-[var(--text-secondary)]">
          确认后会先正式发布你的定位版本，然后自动生成一份第一周计划候选。生成走正常的模型与额度计费；候选不会自动保存为计划，也不会自动创建账号或选题。
        </p>
      )}
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
          {planRecovery !== "idle" && (
            <div className="rounded-xl border border-[var(--border-primary)] p-4">
              {planRecovery === "running" && (
                <p role="status">
                  正在按你刚确认的定位生成第一周计划候选，不需要你再点一次。生成完成后会显示在这里。
                </p>
              )}
              {planRecovery === "unknown" && (
                <p role="status">
                  这次生成的结果暂时无法确认。原请求已保留，不会重复扣费；请刷新页面或重新登录，我们会用同一条请求恢复结果。
                </p>
              )}
              {planRecovery === "invalid" && (
                <p role="status">
                  这次生成完成，但没有返回可用的计划内容，原请求已释放。请核对下方的平台、日期后手动点击生成。
                </p>
              )}
              {planRecovery === "stale" && (
                <p role="status">
                  上一轮定位留下的生成请求已在本机归档，不会执行。请按当前定位重新生成计划候选。
                </p>
              )}
            </div>
          )}
          {shownPlanCandidate && (
            <div className="space-y-3 rounded border border-[var(--border-primary)] p-4">
              <h3>AI 计划候选 · 尚未替换你的编辑</h3>
              <p className="text-xs text-[var(--text-secondary)]">
                以下选题、日期、标题和简报由导师生成。其中的账号名称是待创建的建议，不代表已注册或已验证。
              </p>
              {shownPlanCandidate.map((i) => (
                <p key={i.id}>
                  {i.day} · {i.platform}/{i.account} · {i.title}
                </p>
              ))}
              <Button
                disabled={busy}
                onClick={() => {
                  // Adopting is a local edit only: no model call, and it ends
                  // both the candidate and the envelope that produced it.
                  setItems(shownPlanCandidate);
                  setDirtyPlan(true);
                  clearPlanCandidate();
                  releasePlanEnvelope();
                }}
              >
                采用候选到计划工作稿
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  clearPlanCandidate();
                  releasePlanEnvelope();
                }}
              >
                保留原计划
              </Button>
            </div>
          )}
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
                  {key === "account" && <p className="text-xs text-[var(--text-secondary)]">{list.data?.accounts?.some((a: {platform:string;account:string}) => a.platform === item.platform && a.account === item.account) ? "已有账号 · 保留原工作项" : "待承接账号 · 尚未注册或验证 · 确认后创建"}</p>}
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
          <div className="space-y-3 rounded border border-[var(--border-primary)] p-4">
            <h3>生成前只需要你的事实与选择</h3>
            <p className="text-sm text-[var(--text-secondary)]">
              定位已确认。下面这些是你自己的选择（可以留空由导师按已确认定位建议）；选题、日期、标题和简报由导师生成，不需要你先手动添加选题行。
            </p>
            <div className="flex flex-wrap gap-3">
              <label className="text-sm">
                目标平台（逗号分隔，可留空）
                <input
                  className="ml-2 rounded border bg-[var(--bg-secondary)] p-2"
                  aria-label="目标平台"
                  disabled={busy}
                  value={planPlatform}
                  onChange={(e) => setPlanPlatform(e.target.value)}
                  placeholder="例如 x,douyin"
                />
              </label>
              <label className="text-sm">
                具体账号（逗号分隔，可留空）
                <input
                  className="ml-2 rounded border bg-[var(--bg-secondary)] p-2"
                  aria-label="具体账号"
                  disabled={busy}
                  value={planAccount}
                  onChange={(e) => setPlanAccount(e.target.value)}
                  placeholder="留空则由导师建议名称"
                />
              </label>
              <label className="text-sm">
                开始日期
                <input
                  className="ml-2 rounded border bg-[var(--bg-secondary)] p-2"
                  aria-label="开始日期"
                  type="date"
                  disabled={busy}
                  value={planStart}
                  onChange={(e) => setPlanStart(e.target.value)}
                />
              </label>
              <label className="text-sm">
                天数
                <input
                  className="ml-2 w-20 rounded border bg-[var(--bg-secondary)] p-2"
                  aria-label="计划天数"
                  type="number"
                  min={1}
                  max={28}
                  disabled={busy}
                  value={planDays}
                  onChange={(e) => setPlanDays(Math.min(28, Math.max(1, Number(e.target.value) || 7)))}
                />
              </label>
            </div>
            {planAccount.trim() === "" && (
              <p className="text-xs text-[var(--text-secondary)]">
                没有账号也可以生成。导师建议的账号名称只是待创建的建议，并不代表已经注册或验证过。
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              variant={planNeedsCandidate ? "default" : "outline"}
              disabled={busy || hasUnsavedInformation}
              onClick={generatePlan}
            >
              {shownPlanCandidate || latest ? "重新生成计划候选" : "生成第一周计划"}
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
              variant={planNeedsCandidate ? "outline" : "default"}
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
          {planNeedsCandidate && (
            <p className="text-xs text-[var(--text-secondary)]">
              第一周计划默认由导师先给出候选，你只需要核对和修改。采用候选后，或者已经有保存过的计划版本时，也可以自己增删选题。
            </p>
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
      {notice && <p role="status">{notice}</p>}
    </main>
  );
}
