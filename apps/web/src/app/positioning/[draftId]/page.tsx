"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { use, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WorkspaceFrame } from "@/components/opc/workspace-frame";
import { PanelRightOpen, X } from "lucide-react";
import resultStyles from "@/components/opc/positioning-result.module.css";
import { WorkComposer, useFreeConversation } from '@/components/opc/work-composer';
import { mergeInformation } from "./information-merge";
import { applyMentorTurnRules, readWorkflowMentorExecution } from "./mentor-response";
import {
  confirmationActionIsRedundant,
  confirmQuestionValues,
  displayedReviewQuestion,
  isOpeningInput,
  isReviewOnlySelection,
  navigatorRows,
  nextInformationQuestion,
  OPENING_INPUT,
  openingEntryKey,
  openingRequestId,
  questionIsConfirmed,
  questionLabel,
  questionStatusLabel,
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
/**
 * `consentedAt` records the user's explicit "继续生成第一周选题" choice. It is
 * the only thing that authorizes an automatic first-week topic generation: an
 * envelope without it (a pre-upgrade `v:2`, or a bare legacy request) stays
 * recoverable with its own identity, but is never dispatched on its own.
 */
type PlanEnvelope = { v: 3; sourceRoundId: string | null; consentedAt: string; request: PlanRequest };
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
function readPlanEnvelope(raw: string | null): RetainedPlan | null {
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
  if (!(cause instanceof Error)) return false;
  const data = "data" in cause ? cause.data : undefined;
  // workbench.execute translates internal errors into public messages. Its
  // structured CONFLICT response proves a rejected transaction; a timeout,
  // missing response or another route does not. Keep unknown requests frozen.
  if (
    data && typeof data === "object" &&
    "code" in data && data.code === "CONFLICT" &&
    "path" in data && data.path === "workbench.execute"
  ) return true;
  return [
    "OPC_INFORMATION_CONFLICT",
    "ARTIFACT_VERSION_CONFLICT",
    "ARTIFACT_REVIEW_REQUIRED",
  ].some((code) => cause.message.includes(code));
}
type MentorRequest = {
  draftId: string;
  stepId: string;
  purpose: "mentor";
  requestId: string;
  input: string;
  questionId?: string;
  organizeAfter?: true;
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
/**
 * Provably definite rollbacks of the `opc_handoff` SQL function. Every code
 * below is raised before that function's single durable write, so an exception
 * rolls the whole transaction back and a request carrying it can never commit:
 * releasing the retained request and forming a new explicit one is safe.
 * Timeouts, lost replies and every other error keep it for idempotent replay.
 */
const definiteHandoffRejections = new Set([
  "OPC_ACCOUNT_CONFLICT",
  "OPC_ACCOUNTS_INVALID",
  "OPC_VERSION_CONFLICT",
  "OPC_REQUEST_CONFLICT",
  "OPC_DENIED",
]);
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
  return <PositioningDraftContent key={draftId} draftId={draftId}/>;
}

function PositioningDraftContent({draftId}:{draftId:string}){
  const router = useRouter();
  const planView = usePathname().endsWith("/plan");
  const utils = trpc.useUtils();
  const read = trpc.opc.read.useQuery({ draftId });
  const library = trpc.opc.library.useQuery({search:'',from:null,to:null});
  const discussionAccounts = ((library.data?.businesses??[]) as Array<{accounts:Array<{strategyDraftId?:string;pendingStrategyDraftId?:string|null;displayName?:string;account:string;platform:string}>}>).flatMap(business=>business.accounts).filter(account=>account.pendingStrategyDraftId===draftId||account.strategyDraftId===draftId);
  const discussionAccount = discussionAccounts.length===1?discussionAccounts[0]:undefined;
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
  const [resultOpen,setResultOpen]=useState(true);
  const [workInfoOpen,setWorkInfoOpen]=useState(false);
  useEffect(()=>{if(!workInfoOpen)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setWorkInfoOpen(false);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[workInfoOpen]);
  const [resultBodyNode,setResultBodyNode]=useState<HTMLDivElement|null>(null);
  useEffect(()=>{
    if(!resultBodyNode)return;
    const key='opc-position-result-scroll:'+draftId;
    const frame=requestAnimationFrame(()=>{resultBodyNode.scrollTop=Number(sessionStorage.getItem(key))||0;});
    const save=()=>sessionStorage.setItem(key,String(resultBodyNode.scrollTop));
    resultBodyNode.addEventListener('scroll',save,{passive:true});
    return()=>{cancelAnimationFrame(frame);resultBodyNode.removeEventListener('scroll',save);};
  },[resultBodyNode,draftId]);
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
  const chatRestored = useRef(false), chatFollow = useRef(true);
  const chatKey = 'opc-position-chat-scroll:' + draftId;
  const attachChatScroll = useCallback((node:HTMLDivElement|null)=>{chatScroll.current=node;},[]);
  const [mentorInput, setMentorInput] = useState("");
  const free=useFreeConversation();
  const [manualMentorEnabled, setManualMentorEnabled] = useState(false);
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
  /**
   * The explicit "现在生成第一周选题吗？" ask, and the retained request that is
   * waiting for that decision. Neither can start work on its own.
   */
  const [consentOpen, setConsentOpen] = useState(false);
  const consentDialog = useRef<HTMLDivElement>(null);
  useEffect(() => { if (consentOpen) consentDialog.current?.focus(); }, [consentOpen]);
  const [retainedPlan, setRetainedPlan] = useState<
    { requestId: string; sourceRoundId: string | null } | null
  >(null);
  /**
   * The server's own record for that retained request. It is what lets the page
   * distinguish "never admitted" from "admitted, outcome unknown" truthfully
   * instead of assuming a cancellation or a zero cost.
   */
  const retainedState = trpc.opc.planRequestState.useQuery(
    { draftId, requestId: retainedPlan?.requestId ?? "" },
    { enabled: Boolean(retainedPlan?.requestId) },
  );
  /** The bound topic workspace of this draft (the consented entry target). */
  const bindTopic = trpc.opc.consentTopicWorkspace.useMutation();
  const planEnvelopeKey = "opc-plan-generation:" + draftId;
  const hasUnsavedInformation = Object.keys(infoEdits).length > 0;
  const d = read.data,
    snap = d?.snapshot,
    latest = d?.plans?.[0];
  // `prepareStep`/`execute` are deliberately excluded: the Agent's own opening
  // uses them, and it must never disable the form the user is filling in. Every
  // user-initiated use of them runs inside `run()` (or a named flag), which is
  // what actually gates the controls.
  const busy = bindTopic.isPending ||
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
    setManualMentorEnabled(Boolean(local.manualMentorEnabled));
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
          manualMentorEnabled,
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
    manualMentorEnabled,
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
    if (!d) return;
    if (planAutoRunning.current) return;
    const retained = readRetainedPlan();
    // A local candidate only proves the outcome of the exact request that
    // produced it. It suppresses recovery only when it is that request's
    // terminal result: it belongs to this round and it names the request the
    // retained envelope still authorizes. Any other candidate is a visible
    // fallback — an older request of this round, another round's, or a
    // pre-upgrade buffer with no request identity at all — and the retained
    // request stays an unresolved authorization that must be recovered under
    // its own identity instead of being paid for again.
    if (
      Boolean(planCandidate) &&
      planCandidateRequest !== null &&
      retained?.kind === "envelope" &&
      retained.envelope.request.requestId === planCandidateRequest
    )
      return;
    if (!retained) return;
    if (retained.kind === "invalid") {
      releasePlanEnvelope();
      setPlanRecovery("invalid");
      setNotice(
        "本机保存的计划生成记录无法读取，已停止自动生成。请手动点击生成；只有你确认后才会产生新的模型调用。",
      );
      return;
    }
    // A retained request the user has not explicitly approved, and a bare
    // legacy record, are only surfaced for an explicit decision. Mounting this
    // page, refreshing, re-logging in or following a link is never consent.
    if (retained.kind === "unconsented" || retained.kind === "legacy") {
      setRetainedPlan({
        requestId: retained.request.requestId,
        sourceRoundId:
          retained.kind === "unconsented" ? retained.sourceRoundId : null,
      });
      return;
    }
    setRetainedPlan(null);
    if (retained.envelope.request.draftId !== draftId) {
      archiveStalePlanEnvelope(
        "发现一条属于其它定位草稿的计划生成请求，已在本机归档。它不会被执行，也不会产生费用。",
      );
      return;
    }
    if (retained.envelope.sourceRoundId !== d.roundId) {
      setRetainedPlan({ requestId: retained.envelope.request.requestId,
        sourceRoundId: retained.envelope.sourceRoundId });
      return;
    }
    if (!d.report?.available) return;
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
          candidate.sourceRoundId,
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
    const node=chatScroll.current;
    if(!node||!history.data)return;
    if(!chatRestored.current){
      const saved=sessionStorage.getItem(chatKey);
      node.scrollTop=saved===null?node.scrollHeight:Number(saved)||0;
      chatFollow.current=node.scrollHeight-node.clientHeight-node.scrollTop<64;
      chatRestored.current=true;
    }else if(chatFollow.current) node.scrollTop=node.scrollHeight;
  }, [history.data,chatKey]);
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
    if (!d || !history.data || hydratedDraft !== draftId) return;
    const executions = history.data.executions ?? [];
    for (const execution of executions as Array<{
      executionId: string;
      state: string;
      input: string | null;
      body: string | null;
      primaryBody: string | null;
      summary: string | null;
    }>) {
      if (
        execution.state !== "completed" ||
        appliedMentor.current.has(execution.executionId)
      )
        continue;
      const turn = d.turns?.find(
        (item: { executionId: string; stepId: string; kind: string; roundId?: string; informationVersion?: number }) =>
          item.executionId === execution.executionId &&
          item.roundId === d.roundId &&
          item.informationVersion === d.snapshot.steps[item.stepId]?.version &&
          (item.kind === "mentor" || item.kind === "organizer" || item.kind === "opening"),
      );
      if (!turn) continue;
      const schema = d.information[turn.stepId]?.schema ?? [];
      const rawResponse = execution.body ?? execution.primaryBody;
      // A completed execution can become visible before its public result
      // projection is readable. Do not consume that identity until the result
      // exists, otherwise a later refresh can show the mentor reply without
      // ever applying its form suggestions.
      if (!rawResponse) continue;
      const parsed = readWorkflowMentorExecution(rawResponse, execution.summary, turn.stepId, d.information);
      // A non-substantive user turn (an acknowledgement, an uncertainty or a
      // request for help) never becomes business content on its own.
      const accepted = applyMentorTurnRules(parsed, execution.input ?? "");
      if (!Object.keys(accepted).length || parsed.targetStepId !== turn.stepId ||
          d.snapshot.state !== "draft" || d.snapshot.steps[turn.stepId].valid) {
        appliedMentor.current.add(execution.executionId);
        continue;
      }
      // A saved edit advances the server version; an unsaved edit (including
      // an intentional empty value) also owns this form. History is still
      // readable and its suggestion can be adopted explicitly.
      const old = infoEditsRef.current;
      if (old[turn.stepId]) {
        appliedMentor.current.add(execution.executionId);
        continue;
      }
      const values = Object.fromEntries(
        schema.map((field: { id: string }) => [
          field.id,
          d.information[turn.stepId].values?.[field.id] ?? {
            status: "unknown",
            nature: "unknown",
            value: "",
          },
        ]),
      ) as Record<string, Information>;
      let changed = false;
      for (const [fieldId, suggestion] of Object.entries(accepted)) {
        // A late response is projected onto the question it was actually
        // asked about (its own stored identity), never onto whatever the user
        // is currently reviewing, and never onto an unseen field.
        const turnQuestionId =
          turn.questionId ??
          nextInformationQuestion(schema, d.information[turn.stepId].values)?.id;
        if (fieldId !== turnQuestionId || values[fieldId]?.value.trim()) continue;
        values[fieldId] = toInformation(suggestion);
        changed = true;
      }
      if (!changed) {
        appliedMentor.current.add(execution.executionId);
        continue;
      }
      captureInformationBase(turn.stepId);
      const next = { ...old, [turn.stepId]: values };
      // Autosave reads the ref inside a queued async task. Install the
      // projection synchronously before marking this execution consumed;
      // otherwise a refetch/render race can skip the only recovery attempt.
      infoEditsRef.current = next;
      setInfoEdits(next);
      appliedMentor.current.add(execution.executionId);
    }
  }, [d, history.data, activeQuestions, hydratedDraft, draftId]);
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
    if (d.mode === "manual" && !manualMentorEnabled) return;
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
    // Opening targets the progression question only: reviewing an earlier
    // reached question must never trigger a new paid opening for another one.
    const question = nextInformationQuestion(state.schema, state.values);
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
      (turn.kind === "mentor" || turn.kind === "organizer" || turn.kind === "opening")))
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
  }, [planView, hydratedDraft, draftId, d, history.data, activeStep, activeQuestions, manualMentorEnabled]);
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
   * A local record that an explicit new intent replaces is archived verbatim.
   * Archiving is not a cancellation: whatever state that request reached on the
   * server stays as it is, and the archived copy is only local evidence.
   */
  function archiveRetainedPlanRecord() {
    const raw = sessionStorage.getItem(planEnvelopeKey);
    if (!raw) return;
    sessionStorage.setItem(planEnvelopeKey + ":replaced:" + Date.now(), raw);
    sessionStorage.removeItem(planEnvelopeKey);
    setRetainedPlan(null);
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
    // Read the turn binding and its execution together while the retained
    // envelope still blocks automatic opening. Clearing the envelope first
    // lets that effect race an explicit first message on a manual draft.
    const [draftRead, historyRead] = await Promise.all([read.refetch(), history.refetch()]);
    if (draftRead.error || !draftRead.data || historyRead.error || !historyRead.data)
      throw new Error('OPC_MENTOR_READBACK_UNAVAILABLE');
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
  async function ask(step: Step, questionId: string, inputOverride?: string) {
    const key = "opc-step:" + draftId + ":" + step.id;
    if (sessionStorage.getItem(key)) {
      // A retained envelope still owns this step. Never create a second
      // identity; the explicit recovery control resumes the original request.
      setError("上一条发给导师的内容仍在核对。请先用“继续核对这条原请求”恢复，不会重复发送。");
      return;
    }
    chatFollow.current = true;
    await run(async () => {
      await resumeInterruptedOpening();
      await flushInformation(step.id);
      const fixed: StepEnvelope = {
        request: {
          draftId, stepId: step.id, purpose: "mentor", requestId: crypto.randomUUID(),
          input: (inputOverride ?? mentorInput).trim(), questionId, organizeAfter: true,
        },
      };
      sessionStorage.setItem(key, JSON.stringify(fixed));
      // Reserve the user's turn before enabling the mentor. Otherwise the
      // automatic opening effect races this send and both try to admit work on
      // the same Session.
      if (manualEntry) setManualMentorEnabled(true);
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
  /**
   * Duplicate-action suppression for one explicit button. The requested status
   * is part of the comparison: an unchanged `confirmed → confirmed` action stays
   * a no-op, but `deferred → confirmed` with identical text is a real user
   * action (revisiting a skipped question) and must not be suppressed. A pending
   * envelope is a recovery, never a duplicate.
   */
  function confirmationRedundant(stepId: string, questionId: string, defer = false) {
    if (confirmEnvelopeState(stepId).kind !== "none") return false;
    if (infoEdits[stepId]) return false;
    // A step whose answers are all resolved but which is not valid (typically
    // after an upstream change invalidated it) is waiting for an explicit
    // reconfirmation: resubmitting those same answers is a real action there,
    // not a duplicate. A step that is still being filled in keeps the plain
    // duplicate-suppression behaviour, and a valid step stays a no-op.
    const stepState = snap.steps[stepId] as
      | { valid: boolean; reviewVersion?: number }
      | undefined;
    if (stepState && !stepState.valid) {
      const stepSchema = d.information[stepId]?.schema ?? [];
      const stepValues = d.information[stepId]?.values;
      if (
        stepSchema.length > 0 &&
        stepSchema.every((field: { id: string }) =>
          questionIsConfirmed(stepValues?.[field.id]),
        )
      )
        return false;
    }
    // Reached only when this step has no local edits, so the stored answer is
    // the one the action would confirm or defer.
    const answer = d.information[stepId].values?.[questionId] as
      | Information
      | undefined;
    return confirmationActionIsRedundant(
      answer,
      defer ? "defer" : "confirm",
      answer?.value ?? "",
    );
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
  async function confirmStep(step: Step, stepIndex: number, questionId: string, defer = false, nonAnswers: readonly string[] = [], allowUnreached = false) {
    if (confirmationLock.current) return;
    const envelopeState = confirmEnvelopeState(step.id);
    if (envelopeState.kind === "malformed") {
      setError("上次的确认记录无法读取，结果未知。请先用“恢复上次确认记录并重新读取”保留原始内容，再重新核对本题。");
      return;
    }
    if (
      envelopeState.kind === "none" &&
      !infoEditsRef.current[step.id] &&
      // Compare the requested action with the stored status: a resolved-but-
      // deferred answer must still be explicitly confirmable, so this guard may
      // only short-circuit a genuine duplicate of the same action.
      confirmationRedundant(step.id, questionId, defer) &&
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
        const { values, finishStep } = confirmQuestionValues(schema, current.information[step.id].values ?? {}, questionId, defer, { nonAnswers, allowUnreached });
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
  /**
   * The user-owned choices the generation request is frozen with. Topics,
   * dates, titles and briefs stay the Agent's output.
   */
  function planConstraintsInput() {
    return JSON.stringify({
      confirmedPositioning: positioningSummary(),
      platforms: planPlatform.split(",").map(v => v.trim()).filter(Boolean),
      accounts: planAccount.split(",").map(v => v.trim()).filter(Boolean),
      startDate: planStart,
      days: planDays,
    });
  }
  /**
   * The explicit consent that may start the first-week topic generation. It is
   * a new topic intent. Retained requests always keep their original source;
   * an explicit recovery never becomes authorization for a new round.
   */
  async function consentPlan() {
    if (!d) return;
    const retained = readRetainedPlan();
    const retainedRequest = retained?.kind === "envelope"
      ? retained.envelope.request
      : retained?.kind === "unconsented" || retained?.kind === "legacy"
        ? retained.request : null;
    if (retainedRequest?.draftId === draftId) {
      // Recovery never changes the request's source metadata or creates a new
      // topic intent. Across rounds it is explicit and reads the original run.
      const sourceRoundId = retained?.kind === "envelope" ? retained.envelope.sourceRoundId
        : retained?.kind === "unconsented" ? retained.sourceRoundId : null;
      if (retained?.kind !== "envelope") sessionStorage.setItem(planEnvelopeKey,
        JSON.stringify({ v: 3, sourceRoundId, consentedAt: new Date().toISOString(), request: retainedRequest }));
      setConsentOpen(false);
      if (planView) await run(async () => {
        await runPlanRequest(retainedRequest, sourceRoundId);
        setRetainedPlan(null);
      });
      else router.push(`/positioning/${draftId}/topics`);
      return;
    }
    if (hasUnsavedInformation) return;
    // A replaced local record is preserved verbatim instead of being lost.
    if (retained) archiveRetainedPlanRecord();
    // A fresh intent enters the bound topic workspace: the server freezes the
    // confirmed version, the pinned method revision and its declared topic
    // resources, and refuses when the method declares none. Nothing is
    // dispatched here — the workspace's own turn is the paid action.
    {
      try {
        // This mutation checks the displayed source under the same server lock
        // as binding/consent. No cached read or caught conflict permits a jump.
        const accepted = await bindTopic.mutateAsync({ draftId, sourceVersionId: d.report?.id ?? "" });
        if (!accepted.bound || accepted.sourceVersionId !== d.report?.id)
          throw new Error("OPC_TOPIC_SOURCE_CHANGED");
        setConsentOpen(false);
        router.push(`/positioning/${draftId}/topics`);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        setConsentOpen(false);
        setNotice(message.includes("OPC_TOPIC_SOURCE_CHANGED") || message.includes("OPC_TOPIC_BOUND")
          ? "当前定位版本与原选题工作空间来源不同，已停止进入。原对话和计划保留，请从历史入口核对原来源。"
          : message.includes("OPC_TOPIC_SKILL_MISSING")
            ? "当前定位方法没有声明可用的选题资源，无法开始；本次没有模型调用。"
            : "暂时无法核实选题同意状态，请重试原入口；不会创建第二次首轮意图。");
      }
      return;
    }
  }
  async function generatePlan() {
    chatFollow.current = true;
    await run(async () => {
      await resumeInterruptedOpening();
      if (hasUnsavedInformation) throw new Error("save information first");
      const accountInput = planConstraintsInput();
      // A retained request may only be replayed when it is genuinely the same
      // intent: the user's constraints are unchanged, and the visible candidate
      // does not already close exactly this request. A candidate that names a
      // different request is an older fallback, so the retained request is
      // still an unconfirmed generation and reusing it is what prevents a
      // second request — and a second charge — for the same intent. Anything
      // else is a new explicit authorization.
      const retained = readRetainedPlan();
      const retainedRequest =
        retained?.kind === "envelope" &&
        retained.envelope.sourceRoundId === d.roundId &&
        retained.envelope.request.draftId === draftId
          ? retained.envelope.request
          : retained?.kind === "unconsented" &&
              retained.sourceRoundId === d.roundId &&
              retained.request.draftId === draftId
            ? retained.request
          : retained?.kind === "legacy" && retained.request.draftId === draftId
            ? retained.request
            : null;
      const reuse =
        retainedRequest &&
        !(
          candidateBelongsToCurrentRound() &&
          planCandidateRequest !== null &&
          planCandidateRequest === retainedRequest.requestId
        ) &&
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
        // Clicking "生成候选" is itself an explicit user action, so the
        // request it starts carries the consent marker from here on.
        v: 3,
        sourceRoundId: d.roundId,
        consentedAt: new Date().toISOString(),
        request,
      };
      // A new intent replaces the local record; the old one is archived instead
      // of being silently overwritten.
      if (!reuse) archiveRetainedPlanRecord();
      sessionStorage.setItem(planEnvelopeKey, JSON.stringify(envelope));
      await runPlanRequest(request);
    });
  }
  /**
   * Dispatch the exact frozen request that authorizes this generation, under
   * its own identity. A completed-but-unusable body releases the request; a
   * timeout, a lost reply or any other unknown outcome keeps the envelope so the
   * same request can be replayed instead of paying for a second call.
   */
  async function runPlanRequest(request: PlanRequest, sourceRoundId: string | null = d.roundId) {
      const state = await utils.opc.planRequestState.fetch({ draftId, requestId: request.requestId });
      if (!state.executionId && sourceRoundId !== null && sourceRoundId !== d.roundId) {
        setNotice("原请求属于旧定位轮次，服务端尚无可恢复执行；已保留记录，没有按新定位生成。请核对后另行选择新请求。");
        throw new Error("OPC_OLD_REQUEST_NOT_ADMITTED");
      }
      const prepared = state.executionId ? { executionId: state.executionId }
        : await prepareStep.mutateAsync(request);
      if (state.state !== "completed") await execute.mutateAsync({ executionId: prepared.executionId });
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
      persistPlanCandidate(candidate.body, candidate.sourceRoundId, request.requestId);
      setPlanRecovery("idle");
  }
  /**
   * The retained handoff request, or null when there is none or it cannot be
   * read. An unreadable value is archived verbatim before the current intent
   * replaces it, so the per-draft key can never become a local dead end.
   */
  function readRetainedHandoff(): {
    draftId: string;
    planId: string;
    requestId: string;
    accounts: Array<{
      platform: string;
      account: string;
      expectedRevision: number | null;
    }>;
  } | null {
    const raw = sessionStorage.getItem("opc-confirm:" + draftId);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error("unreadable");
      const { draftId: draft, planId, requestId } = parsed as Record<
        string,
        unknown
      >;
      if (
        typeof draft !== "string" ||
        typeof planId !== "string" ||
        typeof requestId !== "string" ||
        !Array.isArray(parsed.accounts)
      )
        throw new Error("unreadable");
      // Only the fields the strict handoff contract accepts are carried over,
      // so a hand-edited value cannot turn into a permanent schema rejection.
      const accounts = (parsed.accounts as unknown[]).map((entry) => {
        if (!isRecord(entry)) throw new Error("unreadable");
        const { platform, account, expectedRevision } = entry as Record<
          string,
          unknown
        >;
        if (typeof platform !== "string" || typeof account !== "string")
          throw new Error("unreadable");
        if (expectedRevision !== null && typeof expectedRevision !== "number")
          throw new Error("unreadable");
        return {
          platform,
          account,
          expectedRevision: expectedRevision as number | null,
        };
      });
      return { draftId: draft, planId, requestId, accounts };
    } catch {
      try {
        sessionStorage.setItem(
          "opc-confirm-archive:" + draftId + ":" + Date.now(),
          raw,
        );
      } catch {
        /* The archive is evidence only; it never gates the next confirmation. */
      }
      return null;
    }
  }
  /**
   * The business intent one handoff request owns: the draft, the plan version
   * and the normalized platform/account set. `expectedRevision` is an
   * optimistic concurrency guard, so it is deliberately not part of it.
   */
  function handoffIntent(value: {
    draftId: string;
    planId: string;
    accounts: readonly unknown[];
  }) {
    return JSON.stringify([
      value.draftId,
      value.planId,
      value.accounts
        .map((entry) => {
          const account = entry as { platform?: unknown; account?: unknown };
          return [
            typeof account.platform === "string" ? account.platform : "",
            typeof account.account === "string" ? account.account : "",
          ];
        })
        .sort(),
    ]);
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
      const retained = readRetainedHandoff();
      // The retained request is replayed verbatim — same request id and its own
      // frozen expected revisions — only for the exact business intent it was
      // frozen with. That is what makes a lost reply idempotent, and it must
      // not be abandoned merely because the account revisions moved on.
      // A different plan version or platform/account set is an explicit new
      // confirmation: it carries a new request id, and the retained request's
      // immutable server history is neither reused nor rewritten.
      const fixed =
        retained && handoffIntent(retained) === handoffIntent(payload)
          ? retained
          : { ...payload, requestId: crypto.randomUUID() };
      sessionStorage.setItem(key, JSON.stringify(fixed));
      try {
        await handoff.mutateAsync(fixed);
      } catch (cause) {
        // Only a provably definite rollback releases the retained request: that
        // rejected intent can never commit, so the next click must be able to
        // form a new one. Unknown and transport failures keep it for replay.
        if (
          cause instanceof Error &&
          definiteHandoffRejections.has(cause.message)
        ) {
          sessionStorage.removeItem(key);
          // Read the current plan version and account revisions so an explicit
          // retry needs no manual browser-storage reset.
          await Promise.all([list.refetch(), read.refetch()]);
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
  /** The server's identity/lifecycle projection for the retained request. */
  const retainedStateData = retainedState.data as
    | {
        admitted?: boolean;
        state?: string | null;
        hasResult?: boolean;
        materialRevoked?: boolean;
      }
    | undefined;
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
  const manualEntry = d.mode === "manual" && !manualMentorEnabled;
  const hasUnconfirmedRequired = steps.some(step =>
    (d.information[step.id]?.schema ?? []).some((field: { id: string; required: boolean }) =>
      field.required && d.information[step.id]?.values?.[field.id]?.status !== "confirmed"));
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
    summary: string | null;
    state: string;
  };
  const mentorTurns = new Map<string, MentorTurn>(
    ((d.turns ?? []) as MentorTurn[])
      .filter((turn) => turn.kind === "mentor" || turn.kind === "organizer" || turn.kind === "opening")
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
    const parsed = readWorkflowMentorExecution(execution.body ?? execution.primaryBody, execution.summary, turn.stepId, d.information);
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
        const parsed = readWorkflowMentorExecution(execution.body ?? execution.primaryBody, execution.summary, stepId, d.information);
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
      ["mentor", "organizer"].includes(mentorTurns.get(execution.executionId)?.kind ?? "") &&
      !["completed", "cancelled"].includes(execution.state),
  );
  return (
    <WorkspaceFrame area="chat" notice={d?.runtimeMode==='staging_test'?'Staging 真实模型测试 · 未开放联网研究':'本地模拟 · 回复、保存与交接均为演示'} rightOpen={resultOpen} onToggleRight={()=>setResultOpen(value=>!value)} right={<div className={resultStyles.panel}><header><h2>{planView?'已采用选题':'已确认的定位'}</h2><p>{snap.state==='draft'?'已核对信息与当前问题':'当前策略与信息状态'}</p></header><div className={resultStyles.body} ref={setResultBodyNode}>{steps.filter(step=>snap.steps[step.id].valid).map((step,index)=><details key={step.id} open={step.id===selectedStep?.id}><summary><span>{index+1}. {step.title}</span><small>已确认</small></summary><div className={resultStyles.fields}>{(d.information[step.id]?.schema??[]).map((field:{id:string;title:string})=><div key={field.id}><strong>{field.title}</strong><p>{d.information[step.id]?.values?.[field.id]?.value||'待补充'}</p></div>)}</div></details>)}</div></div>}>
    <main className={`${resultStyles.workspaceMain} ${!planView ? resultStyles.conversationPage : ""} h-full w-full overflow-y-auto text-[var(--text-primary)]`}><div className={resultStyles.workspaceContent}>
      <header className={resultStyles.positionTop}>
        <h1>{planView ? "第一周计划" : discussionAccount ? (discussionAccount.displayName??discussionAccount.account)+" · 定位策略" : manualEntry ? "录入已有定位" : "我的定位分析"}</h1>
        <div className={resultStyles.positionActions}>
          <span>{(discussionAccount?discussionAccount.platform:'整体规划')+(snap.state==='published'?' · 已确认':' · 进行中')}</span>
          <button type="button" onClick={()=>setWorkInfoOpen(true)}>工作信息</button>
          {!resultOpen&&<button type="button" aria-label="展开右边栏" onClick={()=>setResultOpen(true)}><PanelRightOpen size={18}/></button>}
        </div>
      </header>
      {workInfoOpen&&<div className={resultStyles.infoBackdrop} onMouseDown={event=>{if(event.target===event.currentTarget)setWorkInfoOpen(false);}}><section role="dialog" aria-modal="true" aria-label="工作信息" className={resultStyles.infoDialog}><header><h2>工作信息</h2><button type="button" aria-label="关闭工作信息" onClick={()=>setWorkInfoOpen(false)}>×</button></header><p>当前工作：{manualEntry?'已有定位录入':'定位分析'}</p><p>状态：{snap.state==='published'?'定位已确认':'定位进行中'}</p><p>定位讨论、待确认修改与历史版本留在原工作；查看不会确认或保存。</p><footer><button type="button" onClick={()=>{void read.refetch();setWorkInfoOpen(false);}}>重新读取状态</button><Link href="/positioning">新任务与账号</Link></footer></section></div>}
      {!planView && <>{hasPendingStepRequest && !busy && (
        <section role="status" aria-label="待恢复的导师请求" className={resultStyles.requestRecovery}>
          <p>上一条消息的结果暂未确认，请恢复后继续。</p>
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
      <nav aria-label="定位步骤" className={resultStyles.phaseStrip} style={{gridTemplateColumns:`repeat(${steps.length},minmax(0,1fr))`}}>
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
            {snap.steps[step.id].valid ? "✓ " : `${index + 1} `}{step.title}
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
          // Server-recorded turns of this draft/round are the durable "already
          // reached" evidence for the review range of this step.
          // The server projection additionally returns the bounded historical
          // reach of this round/step (derived from immutable successful
          // information snapshots), which survives an earlier answer being
          // edited back to a provisional value.
          const reviewReachedIds = [
            ...(((d.information[step.id] as { reached?: string[] } | undefined)
              ?.reached) ?? []),
            ...(
              (d.turns ?? []) as Array<{
                stepId: string;
                questionId: string | null;
                roundId?: string | null;
              }>
            )
              .filter(
                (turn) =>
                  turn.stepId === step.id &&
                  (!Object.hasOwn(turn, "roundId") || turn.roundId === d.roundId),
              )
              .map((turn) => turn.questionId),
          ];
          // The displayed question follows the review selection, so a row that
          // is visible can actually be opened and read. An unresolved
          // confirmation keeps owning its original question.
          const activeQuestion = (pendingConfirmation?.questionId && schema.find(f => f.id === pendingConfirmation.questionId)) || displayedReviewQuestion(schema, d.information[step.id].values, activeQuestions[step.id], reviewReachedIds);
          if (!activeQuestion) return null;
          // Review-only selection: the visible question is not the progression
          // question of an unfinished step, so it stays readable but may not
          // start a confirmation, a deferral or a mentor request.
          const pendingQuestion = nextInformationQuestion(schema, d.information[step.id].values);
          // A pending (or malformed) confirmation envelope keeps owning its own
          // question and must stay resumable, so it is never treated as a pure
          // review selection.
          const reviewOnly =
            confirmationState.kind === "none" &&
            !pendingConfirmation &&
            isReviewOnlySelection(
              schema,
              d.information[step.id].values,
              activeQuestion.id,
              snap.steps[step.id].valid,
            );
          const questionConfirmed =
            questionIsConfirmed(d.information[step.id].values?.[activeQuestion.id]) &&
            !infoEdits[step.id];
          return (
            <article
              key="positioning-workspace"
              className={`${resultStyles.stepArticle} space-y-3`}
            >
              <h2 className="text-lg">
                {index + 1}. {step.title} {s.valid ? "· 已确认" : "· 待确认"}
              </h2>
              {manualEntry && (
                <div role="status" className="space-y-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
                  <p className="font-medium">直接填写完整策略</p>
                  <p className="text-sm text-[var(--text-secondary)]">当前阶段的全部字段都在右侧。内容会自动保存；逐项核对确认后进入下一阶段，全程不会调用 Agent。</p>
                  <Button variant="outline" disabled={busy || hasPendingConfirmation || hasPendingStepRequest} onClick={() => setManualMentorEnabled(true)}>
                    信息不够，让 Agent 帮我补齐
                  </Button>
                  <p className="text-xs text-[var(--text-secondary)]">切换后会带着已保存内容进入同一草稿的导师对话，不会清空或要求机械重填。</p>
                </div>
              )}
              <div className={resultStyles.stepColumns}>
                <aside
                  aria-label="全程导师聊天"
                  className={`${resultStyles.mentorChat} space-y-3`}
                >
                  {manualEntry && <p className="rounded-lg bg-[var(--bg-secondary)] p-3 text-sm">你选择了结构化录入。Agent 当前未启动；直接填写右侧即可。</p>}
                  <div>
                    <p className="text-xs text-[var(--text-secondary)]">全程同一对话</p>
                    <h3 className="font-semibold">
                      和导师一起，一次确认一个问题
                    </h3>
                  </div>
                  <div
                    ref={attachChatScroll}
                    onScroll={event=>{const node=event.currentTarget;chatFollow.current=node.scrollHeight-node.clientHeight-node.scrollTop<64;if(chatRestored.current)sessionStorage.setItem(chatKey,String(node.scrollTop));}}
                    role="log"
                    aria-label="完整导师消息"
                    aria-live="polite"
                    className="max-h-[55vh] min-h-56 space-y-3 overflow-y-auto overscroll-contain pr-2"
                  >
                    {mentorExecutions.length===0&&<div className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
                      <span className={resultStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/>Graylum · 增长顾问</span>
                      <p className={`mt-1 whitespace-pre-wrap break-words ${resultStyles.messageBody}`}>
                        我会在同一个对话里陪你完成全部步骤，一次问一个问题，并把从回答中梳理出的信息放到右侧对应表单，供你核对。
                      </p>
                    </div>}
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
                      const parsed = readWorkflowMentorExecution(execution.body ?? execution.primaryBody, execution.summary, turn?.stepId ?? step.id, d.information);
                      const accepted = applyMentorTurnRules(parsed, execution.input ?? "");
                      const openingTurn = turn?.kind === "opening" || isOpeningInput(execution.input);
                      const target = steps.find(candidate => candidate.id === parsed.targetStepId);
                      const proposed = Object.entries(accepted).filter(([id, value]) =>
                        reachedQuestions(d.information[parsed.targetStepId]?.schema ?? [], d.information[parsed.targetStepId]?.values).some(f => f.id === id) &&
                        value.value !== (infoEdits[parsed.targetStepId]?.[id] ?? d.information[parsed.targetStepId]?.values?.[id])?.value);
                      return (
                        <div key={execution.executionId} data-execution-id={execution.executionId} className="space-y-2">
                          {/* The host opens the question itself: no fabricated user message. */}
                          {!openingTurn && (
                            <div data-message-role="user" className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
                              <span className="text-xs text-[var(--text-secondary)]">
                                你{turnLabel ? ` · ${turnLabel}` : turnStep ? ` · ${turnStep.title}` : ""}
                              </span>
                              <p className={`mt-1 whitespace-pre-wrap break-words ${resultStyles.messageBody}`}>
                                {execution.input ?? "内容暂不可用"}
                              </p>
                            </div>
                          )}
                          <div data-message-role="assistant" className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
                            <span className={resultStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/>
                              {openingTurn ? "导师主动引导" : "导师"}
                              {turnLabel ? ` · ${turnLabel}` : turnStep ? ` · ${turnStep.title}` : ""}
                            </span>
                            <p className={`mt-1 whitespace-pre-wrap break-words ${resultStyles.messageBody}`}>
                              {parsed.message ||
                                (execution.state === "cancelled"
                                  ? "这条回复未发给模型，你可以直接重新描述问题。"
                                  : busy ? "正在回复…" : "回复暂未完成，请继续核对。")}
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
                          {!busy && !["completed", "cancelled"].includes(
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
                  {!manualEntry && snap.state === "draft" && !reviewOnly && <section className={resultStyles.currentAction} aria-label="当前问题操作">
                    <strong>当前核对：{activeQuestion.title}</strong>
                    <p>{(infoEdits[step.id]?.[activeQuestion.id] ?? d.information[step.id].values?.[activeQuestion.id])?.value || '先讨论当前问题，或在右侧填写答案。'}</p>
                    <div>
                      <Button disabled={busy || hasPendingStepRequest || Boolean(pendingMentor) || confirmationState.kind === "malformed" || confirmationRedundant(step.id, activeQuestion.id, false) || !(infoEdits[step.id]?.[activeQuestion.id] ?? d.information[step.id].values?.[activeQuestion.id])?.value?.trim()} onClick={() => confirmStep(step, index, activeQuestion.id, false, nonAnswersFor(step.id, activeQuestion.id), false)}>{pendingConfirmation ? '继续核对本题确认' : '确认当前信息，继续'}</Button>
                      <Button variant="outline" disabled={busy || openingSteps.includes(step.id) || hasPendingConfirmation || hasPendingStepRequest || Boolean(pendingMentor)} onClick={() => { void ask(step, activeQuestion.id, '我不确定，帮我判断。'); }}>我不确定，帮我判断</Button>
                    </div>
                  </section>}
                  </div>
                  <WorkComposer value={mentorInput} onChange={setMentorInput} label="给导师的回复" note={busy && hasPendingStepRequest ? "正在回复…" : undefined} maxLength={8000} disabled={busy||openingSteps.includes(step.id)||Boolean(pendingMentor)||hasPendingConfirmation||hasPendingStepRequest||snap.state!=="draft"||reviewOnly||free.busy} onSend={skill=>{if(skill)void free.send(mentorInput,skill);else void ask(step,activeQuestion.id);}}/>
                  {free.error&&<p role="alert">{free.error}</p>}
                  <p className="text-xs text-[var(--text-secondary)]">
                    同一账号的步骤共用这条对话，未确认内容保留在草稿中。{d?.runtimeMode==='staging_test'?'当前使用真实模型，仅处理你提供的资料。':'当前为隔离模拟，不调用真实模型。'}
                  </p>
                </aside>
                {snap.state === "draft" && resultBodyNode && createPortal(<section
                  aria-label="本步填写信息"
                  className={`${resultStyles.stepForm} space-y-4`}
                >
                  <div className={manualEntry ? undefined : resultStyles.currentQuestionBox}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-[var(--text-secondary)]">
                      {manualEntry ? "当前阶段 · 完整策略" : `当前问题 · ${questionLabel(index, schema, activeQuestion.id)}`}
                      </p>
                      <h3 className="font-semibold">
                        {manualEntry ? `${index + 1}. ${step.title}` : `${questionLabel(index, schema, activeQuestion.id)} ${activeQuestion.title}${activeQuestion.required ? "（必需）" : "（选填）"}`}
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
                  {manualEntry && <p className="text-sm text-[var(--text-secondary)]">填写与自动保存不等于确认；请逐项核对，必需信息全部确认后才能发布正式定位。</p>}
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
                  {(manualEntry ? schema : [activeQuestion]).map((field) => {
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
                          {/* The dynamic question title above is the single
                              visible title for the current question, so no
                              second visible label is rendered for it. The input
                              keeps its accessible name via aria-label, and any
                              other rendered field keeps its own visible label. */}
                          {field.id !== activeQuestion.id && (
                            <label className="block font-medium" htmlFor={`${step.id}-${field.id}`}>
                              {questionLabel(index, schema, field.id)} {field.title}
                              {field.required ? "（必需）" : ""}
                            </label>
                          )}
                          {manualEntry && <p className="text-xs text-[var(--text-secondary)]">
                            {isAgentProposal(field)
                              ? "这是导师要给出的成果建议：由导师根据已确认的资料先提出草案，你只需要核对、修改或确认，不需要自己从头写分析。"
                              : "这是你自己的事实：请按你的真实情况填写，导师不会替你编造。"}
                            {value.status === "provisional" && value.nature === "hypothesis"
                              ? " 当前内容为导师提出的待验证建议。"
                              : ""}
                          </p>}
                          {value.value.trim() && manualEntry && (
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
                            disabled={snap.state !== "draft" || hasPendingConfirmation}
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
                          {manualEntry && <><Button className="w-full" disabled={busy || hasPendingStepRequest || snap.state !== "draft" || Boolean(pendingMentor) || confirmationState.kind === "malformed" || confirmationRedundant(step.id, field.id, false)} onClick={() => confirmStep(step, index, field.id, false, nonAnswersFor(step.id, field.id), true)}>
                            {pendingConfirmation ? "继续核对本题确认" : "确认本题并继续"}
                          </Button><Button variant="outline" className="w-full" disabled={busy || hasPendingConfirmation || hasPendingStepRequest || snap.state !== "draft" || Boolean(pendingMentor) || confirmationState.kind === "malformed" || confirmationRedundant(step.id, field.id, true)} onClick={() => confirmStep(step, index, field.id, true, nonAnswersFor(step.id, field.id), true)}>
                            {field.required ? "按填写的原因暂缓本题并继续" : "暂时跳过本题"}
                          </Button></>}
                          {pendingConfirmation && <p role="status">正在核对原确认请求。确认成功前保持本题，不会跳过下一题。</p>}
                          {!manualEntry && reviewOnly && (
                            <p role="status">
                              这是回看较早的问题：答案与历史仍然可读。当前推进仍在「
                              {pendingQuestion?.title ?? "当前待确认问题"}
                              」，请先回答并确认它；回看本身不会确认、不会推进进度，也不会产生新的模型调用。
                            </p>
                          )}
                          {confirmationState.kind === "valid" && (
                            <p role="status">
      正在继续上次未完成的确认（
                              {confirmationState.envelope.phase === "information"
                                ? "保存本题信息"
                                : confirmationState.envelope.phase === "save"
                                  ? "保存步骤结果"
                                  : "确认步骤"}
                              ）。若长时间没有变化，可点击上方按钮继续核对；原请求会复用，不会重复执行或重复扣费。
                            </p>
                          )}

                        </div>
                      );
                    })}
                  </div>
                  </div>
                  {!manualEntry && <div className={resultStyles.confirmedPositions} aria-label="已确认的定位信息">
                    <p>未确定的建议留在对话中。这里保留已确认信息；修改自动同步，确认与推进仍由你决定。</p>
                    {d.snapshot.workflow.steps.map((confirmedStep:Step,confirmedIndex:number)=>{
                      const info=d.information[confirmedStep.id];
                      const confirmedFields=info.schema.filter((field:{id:string})=>info.values?.[field.id]?.status==='confirmed'||infoEdits[confirmedStep.id]?.[field.id]?.status==='confirmed');
                      if(!confirmedFields.length)return null;
                      return <section key={confirmedStep.id}><h4>{confirmedIndex+1}. {confirmedStep.title}</h4>{confirmedFields.map((field:{id:string;title:string})=>{
                        const value=infoEdits[confirmedStep.id]?.[field.id]??info.values?.[field.id];
                        if(!value)return null;
                        return <label key={field.id}><span>{field.title}</span><Textarea aria-label={`已确认：${field.title}`} maxLength={400} value={value.value} disabled={hasPendingConfirmation} onChange={event=>{
                          captureInformationBase(confirmedStep.id);
                          setInfoEdits(old=>({...old,[confirmedStep.id]:{...Object.fromEntries(info.schema.map((part:{id:string})=>[part.id,old[confirmedStep.id]?.[part.id]??info.values?.[part.id]??{status:'unknown',nature:'unknown',value:''}])),[field.id]:{...value,value:event.target.value,status:event.target.value.trim()?'provisional':'unknown'}}}));
                        }}/><small>{value.status==='confirmed'?'已确认':'修改已自动保存 · 待重新确认'}</small>{value.status!=='confirmed'&&<Button variant="outline" disabled={busy||hasPendingConfirmation||hasPendingStepRequest} onClick={()=>confirmStep(confirmedStep,confirmedIndex,field.id,false,nonAnswersFor(confirmedStep.id,field.id),true)}>确认这项修改</Button>}</label>;
                      })}</section>;
                    })}
                  </div>}
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
                  {(() => {
                    // Ordered navigator over the questions already reached plus
                    // the current one. Rows keep their pinned key/order, so
                    // selecting one never removes, renames or re-sorts another,
                    // and the selected row keeps its own answer status.
                    const rows = navigatorRows(
                      index,
                      schema,
                      d.information[step.id].values,
                      activeQuestion.id,
                      reviewReachedIds,
                    );
                    return rows.length > 1 ? (
                      <nav
                        aria-label="本步骤已到达的问题"
                        className={resultStyles.questionNav}
                      >
                        <p className="text-xs text-[var(--text-secondary)]">
                          本步骤的问题
                        </p>
                        <ul className="space-y-2">
                          {rows.map((row) => (
                            <li key={row.id}>
                              <Button
                                variant={row.selected ? "default" : "outline"}
                                aria-current={row.selected ? "true" : undefined}
                                className="w-full justify-start whitespace-normal text-left"
                                disabled={
                                  busy ||
                                  hasPendingConfirmation ||
                                  hasPendingStepRequest ||
                                  Boolean(pendingMentor)
                                }
                                onClick={() =>
                                  setActiveQuestions((old) => ({
                                    ...old,
                                    [step.id]: row.id,
                                  }))
                                }
                              >
                                {row.label ?? "—"} {row.title} ·{" "}
                                {questionStatusLabel(row.state)}
                                {row.selected ? " · 当前" : ""}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </nav>
                    ) : null;
                  })()}
                </section>,resultBodyNode)}
              </div>
              {s.valid && index === steps.length - 1 && (
                <div
                  role="status"
                  className={resultStyles.completionNotice}
                >
                  <h3>
                    本步骤进度已完成
                  </h3>
                  <p>
                    {snap.state === "published"
                      ? "定位版本已发布。你可以在下方进入第一周计划，或修订定位并保留原版本；历史版本与对话保持不变。"
                      : hasUnconfirmedRequired
                        ? "暂缓内容已保留，但必需信息仍需回来确认，才能发布正式定位。"
                        : "下一步是确认正式定位：发布定位本身不会调用模型；发布后你会被明确询问是否继续生成第一周选题，只有你选择继续时才会调用模型并按额度计费。"}
                  </p>
                </div>
              )}
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
      {!planView && <footer className={resultStyles.publishBar}><div>
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
          hasPendingConfirmation || hasPendingStepRequest || hasUnconfirmedRequired || steps.some((step) => !snap.steps[step.id].valid) ||
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
            // Publishing the confirmed positioning only ends the step-by-step
            // confirmation. It never authorizes a generation: the next step is
            // the explicit "现在生成第一周选题吗？" ask.
            setConsentOpen(true);
          })
        }
      >
        确认正式定位
      </Button>}
      {!planView && snap.state === "published" && (
        <Button
          variant="outline"
          disabled={busy || hasUnsavedInformation || hasPendingStepRequest}
          onClick={() => setConsentOpen(true)}
        >
          继续生成第一周选题
        </Button>
      )}
      </div><p>确认后保存为正式定位；生成选题将在下一步单独确认。</p>
      {d.report?.available && <Link href={`/positioning/${draftId}/topics`}>进入选题工作对话 →</Link>}
      </footer>}
      {consentOpen && (
        <div
          ref={consentDialog}
          role="dialog"
          aria-modal="true"
          aria-label="是否继续生成第一周选题"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") setConsentOpen(false);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className={resultStyles.consentCard}>
            <header>
              <h2>正式定位已发布。现在生成第一周选题吗？</h2>
              <Button className={resultStyles.consentClose} variant="ghost" aria-label="关闭选题询问" disabled={busy} onClick={() => setConsentOpen(false)}><X size={18} aria-hidden="true" /></Button>
            </header>
            <p>
              继续后，Agent 会按你已确认的正式定位和绑定的选题方法开始首轮工作对话。你可以继续补充平台、账号与日期，修改候选。这一步会调用模型并消耗额度；候选不会自动保存为计划，也不会自动创建账号或选题。选择“稍后”不会产生任何调用，正式定位与历史保持原样，你可以随时回来继续。
            </p>
            <div className={resultStyles.consentActions}>
              <Button
                disabled={busy || hasUnsavedInformation}
                onClick={() => void consentPlan()}
              >
                继续生成第一周选题
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setConsentOpen(false)}
              >
                稍后
              </Button>
            </div>
          </div>
        </div>
      )}
      {planView && <Link className="block underline" href={`/positioning/${draftId}`}>返回定位与导师对话</Link>}
      {planView && !d.report?.available && <p role="status">请先确认正式定位，再制定第一周计划。原定位和对话仍保留。</p>}
          {planView && retainedPlan && (
            <div className="space-y-3 rounded-xl border border-[var(--border-primary)] p-4">
              <h3>本机保留了一条早先的生成请求</h3>
              <p className="text-sm text-[var(--text-secondary)]" role="status">
                请求标识 {retainedPlan.requestId.slice(0, 8)}…
                {retainedPlan.sourceRoundId
                  ? "（属于本机记录的这份定位）"
                  : "（更早的一份本机记录）"}
                。
                {retainedState.isLoading
                  ? "正在核对它在服务端的状态…"
                  : retainedState.error || !retainedStateData
                    ? "暂时无法核对它的服务端状态；它不会被自动执行。你可以稍后重试核对，或按原身份继续恢复。"
                    : !retainedStateData.admitted
                      ? "服务端没有这条请求的准入记录：它尚未开始，也没有产生执行、预留或费用。"
                      : retainedStateData.materialRevoked
                        ? "这条请求绑定的来源已撤回：服务端保留了原记录，但不能按原来源继续派发。"
                        : retainedStateData.state === "completed"
                          ? retainedStateData.hasResult
                            ? "服务端已保存这条请求的完成结果，可以按原身份恢复读取，不会重新派发。"
                            : "服务端记录这条请求已完成，但没有可读结果；继续只会按原身份核对，不会重新派发。"
                          : retainedStateData.state === "cancelled"
                            ? "服务端记录这条请求已取消；继续只会按原身份核对，不会重新派发。"
                            : `服务端已记录这条请求（${retainedStateData.state ?? "状态未知"}）：结果尚未确定，继续会按原身份恢复，不会重复派发或重复扣费。`}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button disabled={busy} onClick={() => void consentPlan()}>
                  继续这条原请求
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || hasUnsavedInformation}
                  onClick={() => {
                    // A fresh generation is a separate explicit action: the old
                    // local record is archived (its server state is untouched),
                    // then the consent ask starts a new identity.
                    archiveRetainedPlanRecord();
                    setConsentOpen(true);
                  }}
                >
                  重新生成（新请求）
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    archiveRetainedPlanRecord();
                    setNotice(
                      "本机记录已归档保留；这条请求在服务端的状态不受影响。",
                    );
                  }}
                >
                  归档这条本机记录
                </Button>
              </div>
            </div>
          )}
          {planView && planCandidate && planCandidateRound && planCandidateRound !== d.roundId && (
            <div className="space-y-3 rounded border border-[var(--border-primary)] p-4">
              <h3>原定位轮次的计划结果 · 已恢复</h3>
              <p>这是原请求的完成结果，保留原定位来源；没有按当前定位重新生成，也不会替换当前计划。</p>
              {planCandidate.map(item => <p key={item.id}>{item.day} · {item.platform}/{item.account} · {item.title} · {item.brief}</p>)}
            </div>
          )}
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
    </div></main></WorkspaceFrame>
  );
}
