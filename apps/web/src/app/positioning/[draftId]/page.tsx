"use client";
import { readAgentTurnBody, type AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { use, useEffect, useRef, useState, type ReactNode } from "react";
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
import { createInformationAutosave, informationBaseKey, tabStorage, savedRead, stepView, type AutosaveIo, type SaveState } from "./information-autosave";
import { readPlanEnvelope, type PlanEnvelope, type PlanRequest } from "./plan-envelope";
import { admissionMessage } from "./admission-message";
import { readWorkflowMentorExecution } from "./mentor-response";
import { focusReply, mentorReplyDisplay, showsTurnState } from "./agent-turn-display";
import { OpenQuestionRecord, OTHER_PLACEHOLDER, QuestionCardView } from "@/components/opc/question-card";
import { CaptureChecklist } from "@/components/opc/capture-checklist";
import { StepReviewDialog } from "@/components/opc/step-review-dialog";
import { focusChecklistField, StepConfirmCard } from "@/components/opc/step-confirm-card";
import { cardStatus, editedValue, fieldMeta, focusField, type StepInformation } from "@/components/opc/capture-state";
import { reviewedStep, useStepConfirmation } from "@/hooks/use-step-confirmation";
import { useCaptureResolve } from "@/hooks/use-capture-resolve";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { ChatInlineNotice, ChatNoticeList, ChatPendingStatus } from "@/components/chat/ChatInlineNotice";
import { useMentorLogScroll } from "./use-mentor-log-scroll";
import { mentorTailNotices, mentorTurnNotice, RETRY_PENDING_NOTICE, turnNeedsRetry } from "./mentor-notices";
import { useAutoStepRecovery, useHistoryPolling } from "./use-step-recovery";
import { useLiveReply } from "./use-live-reply";
import { ReportEntry } from "./report-panel";
import { sameRequest, releaseRejectedAnswer, openingRequest, parseStepEnvelope, type MentorRequest,
  retainExecution, settleEnvelope, TEXT_PROTOCOL, turnResultNotice, type MentorTurn, type MentorExecution } from "./mentor-turn";
import { usePaygResume } from "@/lib/use-payg-resume";
import { openOrganizer } from "@/lib/payg-wait";
import { isOpeningInput, openingEntryKey } from "@repo/api/src/shared/opcQuestions";
type Step = { id: string; title: string; dependsOn?: string[] };
import { isRecord, type Information, type Item, type StepEnvelope } from "./confirm-envelope";
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
  const prepareStep = trpc.opc.prepareStep.useMutation();
  const [pendingBubble,setPendingBubble]=useState<MentorRequest|null>(null);
  const [foldedCard,setFoldedCard]=useState(''); // Execution whose docked question card the user folded away.
  const mentorSendInFlight=useRef(false);
  /** One turn's events: a resumed execution passes its id, a new turn learns it from `admitted`. */
  const streamTurn=(open:()=>Promise<AsyncIterable<AgentTurnEvent>>,executionId?:string,onAdmitted?:(id:string)=>void)=>
    live.stream(open,{executionId,onAdmitted,onFinished:()=>void utils.credits.getBalance.invalidate(),
      onResult:result=>{const notice=turnResultNotice(result);if(notice)setError(notice);}});
  const execute={mutateAsync:(input:{executionId:string})=>
    streamTurn(()=>utils.client.runtime.executeStream.mutate({...input,textProtocol:TEXT_PROTOCOL}),input.executionId)};
  /** A mentor turn in one request: admission, then the same execution stream (AC-1). */
  const mentorTurn=(request:MentorRequest,onAdmitted?:(id:string)=>void)=>
    streamTurn(()=>utils.client.opc.mentorTurnStream.mutate({...request,textProtocol:TEXT_PROTOCOL}),undefined,onAdmitted);
  const information = trpc.opc.information.useMutation();
  const [infoEdits, setInfoEdits] = useState<
    Record<string, Record<string, Information>>
  >({});
  const revise = trpc.opc.revise.useMutation();
  const change = trpc.workbench.execute.useMutation(),
    savePlan = trpc.opc.savePlan.useMutation(),
    handoff = trpc.opc.handoff.useMutation();
  const [running, setRunning] = useState(false);
  const [resultOpen,setResultOpen]=useState(true), [highlight,setHighlight]=useState<{ stepId: string; fieldIds: string[] }>(), [reveal,setReveal]=useState(0);
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
  const history = trpc.runtime.view.useQuery({ sessionId: read.data?.sessionId ?? "" },
    { enabled: Boolean(read.data?.sessionId), refetchInterval: useHistoryPolling(draftId, read.data?.snapshot?.workflow.steps ?? []) });
  const live = useLiveReply(draftId, history.data), liveReply = live.reply, stopLocal = live.stopLocal;
  const payg = usePaygResume(() => Promise.all([read.refetch(), history.refetch(), utils.credits.getBalance.invalidate()]));
  const [activeStep, setActiveStep] = useState<string | null>(null);
  // State, not a ref: on a client-side return cached history exists before the log mounts.
  const [mentorInput, setMentorInput] = useState("");
  const free=useFreeConversation();
  const [manualMentorEnabled, setManualMentorEnabled] = useState(false);
  const [hydratedDraft, setHydratedDraft] = useState<string | null>(null);
  const [, refreshStepEnvelopes] = useState(0);
  useEffect(() => {
    if (!read.data || !history.data || hydratedDraft !== draftId) return;
    let removed = false;
    for (const stepId of Object.keys(read.data.information ?? {})) {
      const key = "opc-step:" + draftId + ":" + stepId;
      const raw = sessionStorage.getItem(key);
      const envelope = raw ? parseStepEnvelope(raw) : null;
      if (!envelope || envelope.request.draftId !== draftId || envelope.request.stepId !== stepId) continue;
      const request = {...envelope.request};
      // Runtime defaults an omitted organizer flag to false. Normalize only
      // that legal representation; all other identity fields/extra keys stay exact.
      if (request.organizeAfter === false) delete request.organizeAfter;
      const stopped = history.data.executions?.some((execution: {
        executionId: string; state: string; request?: MentorRequest;
        billing?: {closed?: boolean; cancelRequested?: boolean};
      }) => execution.state === "cost_pending" && execution.billing?.closed === true &&
        execution.billing.cancelRequested === true && execution.executionId !== history.data.activeExecution &&
        execution.request && sameRequest(request, execution.request));
      // Only an exact server-persisted, stopped request retires this local lock.
      if (stopped && sessionStorage.getItem(key) === raw) {
        sessionStorage.removeItem(key); removed = true;
      }
    }
    if (removed) refreshStepEnvelopes(value => value + 1);
  }, [read.data, history.data, hydratedDraft, draftId]);

  useEffect(()=>{
    if(!read.data||hydratedDraft!==draftId)return;
    const retained=Object.keys(read.data.information??{}).map(stepId=>{
      const raw=sessionStorage.getItem("opc-step:"+draftId+":"+stepId);
      return raw?parseStepEnvelope(raw)?.request:null;
    }).find(request=>request?.draftId===draftId&&request.input?.trim());
    setPendingBubble(retained??null);
  },[read.data,hydratedDraft,draftId]);

  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [informationConflicts, setInformationConflicts] = useState<Record<string, { current: Record<string, Information>; fields: string[] }>>({});
  const infoEditsRef = useRef(infoEdits);
  const composing = useRef(false);
  const autosaveIo = useRef<AutosaveIo>(null!);
  autosaveIo.current = {
    draftId, storage: tabStorage, newId: () => crypto.randomUUID(), onError: setError,
    cached: stepId => stepView(utils.opc.read.getData({ draftId }), stepId),
    refetch: async stepId => stepView((await read.refetch()).data, stepId),
    write: request => information.mutateAsync(request),
    applySaved: (stepId, values, version) => utils.opc.read.setData({ draftId }, (old: unknown) => savedRead(old, stepId, values, version)),
    refreshLater: () => { if (!Object.keys(infoEditsRef.current).length) void utils.opc.read.invalidate({ draftId }); },
    edits: () => infoEditsRef.current,
    setEdits: (stepId, values) => {
      const next = { ...infoEditsRef.current };
      if (values) next[stepId] = values; else delete next[stepId];
      infoEditsRef.current = next; setInfoEdits(next);
    },
    setSaveState: (stepId, state) => setSaveState(old => ({ ...old, [stepId]: state })),
    setConflict: (stepId, conflict) => setInformationConflicts(old => ({ ...old, [stepId]: conflict })),
  };
  const [autosave] = useState(() => createInformationAutosave(() => autosaveIo.current));
  const flushInformation = autosave.flush;
  useEffect(() => {
    // Mirror `infoEdits` before scheduling: the scheduler reads the ref.
    infoEditsRef.current = infoEdits;
    if (planView || hydratedDraft !== draftId || composing.current) return;
    autosave.schedule();
    return autosave.cancel;
  }, [planView, draftId, hydratedDraft, infoEdits]);
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
  /** Utterances the mentor classified as non-answers in one step: never confirmed as content. */
  function nonAnswersFor(stepId: string) {
    const turns = new Map(((d?.turns ?? []) as MentorTurn[]).map(turn => [turn.executionId, turn]));
    return ((history.data?.executions ?? []) as MentorExecution[])
      .filter(execution => turns.get(execution.executionId)?.stepId === stepId)
      .map(execution => readWorkflowMentorExecution(execution.body ?? execution.primaryBody, execution.summary, stepId,
        d.information).inputKind === "answer" ? "" : execution.input ?? "")
      .filter(Boolean);
  }
  const confirmation = useStepConfirmation({
    draftId, ready: hydratedDraft === draftId, steps: (snap?.workflow.steps ?? []) as Step[],
    refetch: () => read.refetch(), flush: flushInformation, pendingEdits: stepId => infoEditsRef.current[stepId],
    releaseEdits: (stepId, editingSnapshot) => setInfoEdits(old => {
      if (JSON.stringify(old[stepId] ?? null) !== editingSnapshot) return old;
      const next = { ...old }; delete next[stepId]; infoEditsRef.current = next; return next;
    }),
    writeInformation: input => information.mutateAsync(input),
    transition: input => change.mutateAsync(input as Parameters<typeof change.mutateAsync>[0]),
    run, nonAnswers: nonAnswersFor, setError, setRunning,
    onConfirmed: stepId => {
      // Confirmed: move on to the next step, whose opening the Agent sends by itself.
      const flow = (snap?.workflow.steps ?? []) as Step[], index = flow.findIndex(step => step.id === stepId);
      if (!d?.accountRevision && index >= 0 && index < flow.length - 1) setActiveStep(flow[index + 1]!.id);
    },
  });
  const captureResolve = trpc.opc.captureResolve.useMutation(), capturePending = trpc.opc.capturePending.useMutation();
  const updates = useCaptureResolve({ draftId, active: !planView && hydratedDraft === draftId && snap?.state === "draft",
    refetch: () => read.refetch(), flush: flushInformation, setError,
    resolve: input => captureResolve.mutateAsync(input), pending: input => capturePending.mutateAsync(input) });
  // `prepareStep`/`execute`/`mentorTurn` are deliberately excluded: the Agent's own
  // opening uses them, and it must never disable the form the user is filling in. Every
  // user-initiated use of them runs inside `run()` (or a named flag), which is
  // what actually gates the controls.
  const busy = bindTopic.isPending ||
    running || confirmation.confirming || Boolean(updates.resolving) ||
    revise.isPending ||
    change.isPending ||
    savePlan.isPending ||
    handoff.isPending || payg.busy;
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
    mentorInput,
    manualMentorEnabled,
  ]);
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
  // Legacy links expose only an existing request. Opening a link is never
  // permission to admit another request or to replace the current topic work.
  useEffect(() => {
    if (!planView || hydratedDraft !== draftId || !d) return;
    const retained = readRetainedPlan();
    if (!retained) { router.replace(`/positioning/${draftId}/topics`); return; }
    if (retained.kind === "invalid") {
      setNotice("本机旧请求无法读取，原记录已保留；没有开始新的生成。");
      return;
    }
    const request = retained.kind === "envelope" ? retained.envelope.request : retained.request;
    if (request.draftId !== draftId) {
      setNotice("这条本机记录属于其它定位，不能在当前工作恢复；原记录已保留。");
      return;
    }
    setRetainedPlan({ requestId: request.requestId, sourceRoundId:
      retained.kind === "envelope" ? retained.envelope.sourceRoundId :
      retained.kind === "unconsented" ? retained.sourceRoundId : null });
  }, [planView, hydratedDraft, draftId, d?.roundId]);
  const { attach: attachChatScroll, follow: chatFollow, onScroll: onChatScroll } = useMentorLogScroll(draftId, history.data, pendingBubble, liveReply);
  function captureInformationBase(stepId: string) {
    const key = informationBaseKey(draftId, stepId);
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify(d.information[stepId].values ?? {}));
  }
  /**
   * The Agent opens each step itself, once per step and round, so a beginner is
   * never asked to send a placeholder like "你好" or "继续" first. It runs on first
   * entry into a step and again after a confirmation advances to the next one.
   * The request identity is derived from draft, round, step and the step's first
   * declared field (the server derives the same one), so a refresh, a re-login,
   * a second tab or a lost reply reuses the same turn instead of paying twice.
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
    // Only the current pending step is opened; reviewing a confirmed step restores
    // its content and never generates another turn.
    if (d.snapshot.steps[step.id].valid || stepIndex !== firstPending) return;
    const question = d.information[step.id].schema[0] as { id: string } | undefined;
    if (!question) return;
    const turns = (d.turns ?? []) as Array<{ stepId: string; roundId?: string | null; kind: string }>;
    // One opening per step and round. Any turn of this step in this round (an
    // earlier opening, or a conversation started on an older page) means the
    // step is already open. A turn from an older round never suppresses the
    // current round's opening: the round is part of the request identity.
    // A projection without round ownership keeps the previous round-blind behaviour.
    const sameRound = (turn: { roundId?: string | null }) =>
      !Object.hasOwn(turn, "roundId") || turn.roundId === d.roundId;
    if (turns.some(turn => turn.stepId === step.id && sameRound(turn) &&
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
        await mentorTurn(openingRequest(draftId, d.roundId, step.id, question.id));
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
        setNotice("");live.clear();
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
  }, [planView, hydratedDraft, draftId, d, history.data, activeStep, manualMentorEnabled]);
  const recoveryNeedsUser = useAutoStepRecovery({ history: history.data, historyFailed: history.isError, draftId, recover: recoverPendingStep,
    steps: (d?.snapshot.workflow.steps ?? []) as Step[],
    ready: !planView && hydratedDraft === draftId, blocked: busy || openingSteps.length > 0 });
  async function run(fn: () => Promise<unknown>) {
    setRunning(true);
    setError("");
    try {
      await fn();
      await read.refetch();
      await list.refetch();
      await history.refetch();
    } catch (cause) {
      setError(admissionMessage(cause) ??
        "操作未完成或版本已变化。编辑已保留；请重新读取状态，确认当前版本后再操作。",
      );
      return cause;
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
    const request = fixed.request;
    if (!request.input?.trim()) throw new Error("OPC_INPUT_REQUIRED");
    let executionId = fixed.executionId;
    const result = executionId ? await execute.mutateAsync({ executionId })
      : await mentorTurn(request, id => { executionId = id; retainExecution(sessionStorage, key, request.requestId, id); }).catch(async cause => {
        if (releaseRejectedAnswer(sessionStorage, key, request.requestId, cause)) {
          setPendingBubble(old => old?.requestId === request.requestId ? null : old); live.clear();
          await Promise.all([read.refetch(), history.refetch()]);
        }
        throw cause;
      });
    // Read the turn binding and its execution together while the retained
    // envelope still blocks automatic opening. Clearing the envelope first
    // lets that effect race an explicit first message on a manual draft.
    const [draftRead, historyRead] = await Promise.all([read.refetch(), history.refetch()]);
    if (draftRead.error || !draftRead.data || historyRead.error || !historyRead.data)
      throw new Error('OPC_MENTOR_READBACK_UNAVAILABLE');
    // A running execution keeps envelope and bubble until a resume sees a terminal result; a Q1 refusal refills the box.
    if (!settleEnvelope(sessionStorage, key, request.requestId, executionId, result)) return;
    setPendingBubble(old=>old?.requestId===request.requestId?null:old);if(!payg.admitted(result))setMentorInput(old=>old.trim()?old:request.input);
    live.clear();
  }
  async function resumeInterruptedOpening() {
    // An Agent opening interrupted by a reload can still own the session's
    // active execution. Resume that same execution before creating a new turn:
    // a new admission would be refused while the session is busy, and the
    // user's own action would be lost. Resuming is idempotent.
    const interrupted = mentorExecutions.find(
      execution =>
        mentorTurns.get(execution.executionId)?.kind === "opening" &&
        execution.executionId === history.data?.activeExecution,
    );
    if (interrupted)
      await execute.mutateAsync({ executionId: interrupted.executionId });
  }
  /**
   * One user turn on a step. The focus is only the request identity: the server
   * re-derives it, and an answered card keeps the card's own turn.
   */
  async function ask(step: Step, inputOverride?: string, answerSource?: MentorRequest["answerSource"]) {
    if(mentorSendInFlight.current)return;
    const key = "opc-step:" + draftId + ":" + step.id;
    if (sessionStorage.getItem(key)) {
      // A retained envelope still owns this step. Never create a second
      // identity; the explicit recovery control resumes the original request.
      setError("上一条发给导师的内容仍在核对。请先点“重试”恢复，不会重复发送。");
      return;
    }
    if(running||openingInFlight.current.size||history.data?.activeExecution)return;
    const input=(inputOverride??mentorInput).trim();if(!input)return;
    const latest = mentorExecutions.at(-1), sourceTurn = latest && mentorTurns.get(latest.executionId);
    // Typing instead of choosing still answers the newest card of this step and round.
    if (!answerSource && latest?.state === "completed" && sourceTurn && sourceTurn.roundId === d.roundId &&
      sourceTurn.stepId === step.id && readAgentTurnBody(latest.body).card)
      answerSource = { executionId: latest.executionId };
    const questionId = focusField(d.information[step.id]);
    const fixed:StepEnvelope={request:{...(answerSource ? {answerSource} : {}),draftId,stepId:step.id,
      purpose:'mentor',requestId:crypto.randomUUID(),input,questionId,organizeAfter:true}};
    sessionStorage.setItem(key,JSON.stringify(fixed));
    mentorSendInFlight.current=true;
    setPendingBubble(fixed.request);if(inputOverride===undefined)setMentorInput('');
    chatFollow.current=true;
    if(manualEntry)setManualMentorEnabled(true);
    try{await run(async()=>{await flushInformation(step.id);await resumeStepEnvelope(step,fixed);});}
    finally{mentorSendInFlight.current=false;}
  }

  function recoverPendingStep(step: Step, quiet = false) { setActiveStep(step.id); return recoverStep(step, quiet); } // Retry; also the automatic path.
  async function recoverStep(step: Step, quiet = false) {
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
    const failure = await run(async () => {
      await resumeStepEnvelope(step, envelope.parsed!);
    });
    // A mismatch or unknown outcome retains the original identity for a later
    // explicit retry instead of orphaning the request.
    // An automatic attempt stays quiet; the compact retry line asks the user once attempts run out.
    if (sessionStorage.getItem(key))
      setError(quiet ? "" : admissionMessage(failure) ?? RETRY_PENDING_NOTICE);
  }
  const sameInformation = (a?: Information, b?: Information) => a?.value === b?.value && a?.status === b?.status && a?.nature === b?.nature;
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
      if (!state.executionId && (planView || (sourceRoundId !== null && sourceRoundId !== d.roundId))) {
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
  if (planView) return <main className="mx-auto max-w-3xl space-y-4 p-6">
    <Link href={`/positioning/${draftId}/topics`}>进入当前选题工作</Link>
    <h1>旧计划请求恢复</h1>
    {error && <ChatInlineNotice tone="error">{error}</ChatInlineNotice>}
    <p>这里只恢复原请求及其结果，不创建新请求，不替换当前工作。</p>
    {notice && <ChatInlineNotice tone="warning">{notice}</ChatInlineNotice>}
    {retainedPlan && <section className="space-y-3">
      <h2>本机保留了一条早先的生成请求</h2>
      <p role="status">{retainedState.isLoading ? "正在核对原请求…" : retainedState.error || !retainedStateData
        ? "暂时无法核对原请求，请稍后重试；原记录仍保留。"
        : !retainedStateData.admitted ? "服务端没有这条请求的准入记录；没有开始新的生成。"
        : retainedStateData.materialRevoked ? "原请求来源已撤回，不能继续恢复。"
        : retainedStateData.hasResult ? "服务端已保存这条请求的完成结果，可以按原身份恢复读取。"
        : "原请求结果尚未确定；继续使用原身份恢复，不会重复执行或重复扣费。"}</p>
      <Button disabled={busy || !retainedStateData?.admitted || retainedStateData.materialRevoked || Boolean(retainedState.error)} onClick={() => void run(async () => {
        const retained = readRetainedPlan();
        if (!retained || retained.kind === "invalid") throw new Error("OPC_REQUEST_INVALID");
        const request = retained.kind === "envelope" ? retained.envelope.request : retained.request;
        if (request.draftId !== draftId || request.requestId !== retainedPlan.requestId) throw new Error("OPC_REQUEST_CONFLICT");
        try { await runPlanRequest(request, retainedPlan.sourceRoundId); }
        catch { setNotice("这次生成的结果暂时无法确认。原请求与原始记录仍保留，请稍后按原身份恢复。"); }
      })}>继续这条原请求</Button>
      {planCandidate && planCandidateRequest === retainedPlan.requestId && retainedStateData?.hasResult && !retainedStateData.materialRevoked && !retainedState.error && <section>
        <h2>{planCandidateRound !== d.roundId ? "原定位轮次的计划结果 · 已恢复" : "AI 计划候选 · 尚未替换你的编辑"}</h2>
        <p>保留原定位来源，当前选题与编辑没有改变。</p>
        {planCandidate.map(item => <p key={item.id}>{item.day} · {item.platform}/{item.account} · {item.title} · {item.brief}</p>)}
      </section>}
    </section>}
  </main>;
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
  const manualEntry = d.mode === "manual" && !manualMentorEnabled && !d.accountRevision;
  const hasUnconfirmedRequired = steps.some(step =>
    (d.information[step.id]?.schema ?? []).some((field: { id: string; required: boolean }) =>
      field.required && d.information[step.id]?.values?.[field.id]?.status !== "confirmed"));
  const nextReviewStep = steps.find(step => (d.information[step.id]?.schema ?? []).some((field: {id:string;required:boolean}) => {
    const value=d.information[step.id]?.values?.[field.id];
    const original=d.accountRevision?.sourceInformation?.[step.id]?.values?.[field.id];
    return field.required ? value?.status !== "confirmed" : !["confirmed", "deferred"].includes(value?.status) && !sameInformation(value,original);
  }));
  const selectedStep =
    steps.find((step) => step.id === activeStep) ??
    steps[Math.max(0, firstPending)];
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
  const hasPendingConfirmation = steps.some(step => confirmation.envelopeState(step.id).kind === "valid");
  /** A streaming reply whose execution is not in history yet. */
  const liveOnly = liveReply && !mentorExecutions.some(e => e.executionId === liveReply.executionId) ? liveReply : null;
  // The one open question card, docked to the message box. Set while the conversation renders.
  let chatShown = false, lastTurnNotice = false, lastTurnText = "";
  let dock: ReactNode = liveOnly?.card ? <QuestionCardView key="live" card={liveOnly.card} disabled docked/> : null;
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
  const awaitingReply = hasPendingStepRequest && !recoveryNeedsUser.length;
  // The server execution slot owns concurrency. A stopped historical call may
  // still have pending cost without owning that slot; never infer busy from cost.
  const pendingMentor = mentorExecutions.find(
    (execution) =>
      ["mentor", "organizer"].includes(mentorTurns.get(execution.executionId)?.kind ?? "") &&
      execution.executionId === history.data?.activeExecution,
  );
  /** A user edit of one field: autosaved like before, so the server marks it as the user's. */
  function editField(stepId: string, fieldId: string, text: string) {
    captureInformationBase(stepId);
    setInfoEdits(old => {
      const info = d.information[stepId];
      const values: Record<string, Information> = Object.fromEntries(info.schema.map((field: { id: string }) =>
        [field.id, old[stepId]?.[field.id] ?? info.values?.[field.id] ?? { status: "unknown", nature: "unknown", value: "" }]));
      values[fieldId] = editedValue(values[fieldId]!, text);
      return { ...old, [stepId]: values };
    });
  }
  /** A step can be confirmed once the steps it depends on are confirmed. */
  function confirmableStep(step: Step) { if (pendingMentor || awaitingReply || liveOnly || mentorExecutions.some(openOrganizer)) return false;
    if (steps.some(other => other.id !== step.id && confirmation.envelopeState(other.id).kind === "valid")) return false;
    return Boolean(d.accountRevision) || (step.dependsOn ? step.dependsOn.every(id => snap.steps[id]?.valid) : steps.indexOf(step) <= firstPending);
  }
  function openReview(stepId: string) { setActiveStep(stepId); confirmation.open(stepId, d.information[stepId], infoEditsRef.current[stepId], snap.steps); }
  const highlightFields = (step: string) => (ids: string[]) => { // “我要改”: show the checklist, mark these fields, cursor in the first.
    setResultOpen(true); setReveal(n => n + 1); setHighlight({ stepId: step, fieldIds: ids }); focusChecklistField(step, ids[0]); };
  function retrySave(stepId: string) {
    const values = infoEditsRef.current[stepId];
    if (values) void autosave.enqueue(stepId).catch(() => setError("自动保存仍未成功。内容已保留，请稍后重试。"));
  }
  function checklistProps(): Parameters<typeof CaptureChecklist>[0] {
    const locked = busy || hasPendingStepRequest || Boolean(pendingMentor);
    return {
      steps, information: d.information, edits: infoEdits, selectedStepId: selectedStep.id, editable: snap.state === "draft",
      valid: Object.fromEntries(steps.map(step => [step.id, Boolean(snap.steps[step.id].valid)])),
      manual: manualEntry, locked, saveState, highlight, conflicts: informationConflicts, resolving: updates.resolving,
      confirmable: stepId => confirmableStep(steps.find(step => step.id === stepId)!),
      confirmation: stepId => confirmation.envelopeState(stepId).kind,
      onEdit: editField, onReview: openReview, onRecoverConfirmation: stepId => void confirmation.recoverMalformed(stepId),
      onResolve: (stepId, fieldId, suggestion, action) => void updates.resolve(stepId, fieldId, suggestion, action),
      onKeepConflict: retainConflictingInput, onRetrySave: retrySave,
      onComposition: (stepId, active) => {
        composing.current = active;
        if (!active) retrySave(stepId);
      },
    };
  }
  function reviewDialog(review: NonNullable<typeof confirmation.review>) {
    const step = steps.find(item => item.id === review.stepId), info = d.information[review.stepId] as StepInformation; if (!step) return null;
    // Only the updates the user saw when the review opened are listed; a newer one makes the submit stop.
    const shown = Object.fromEntries(info.schema.flatMap(field => {
      const update = fieldMeta(info, field.id).suggestion;
      return update && review.baseline.updates[field.id] === update.executionId + ":" + update.hash ? [[field.id, update.value]] : [];
    }));
    const reviewed = reviewedStep(review, infoEdits[review.stepId]);
    return <StepReviewDialog title={step.title} schema={info.schema} reviewed={reviewed}
      updates={shown} deferred={review.deferred} problems={review.problems} changed={review.changed} onDefer={confirmation.setDeferred}
      onEdit={(fieldId, value) => { confirmation.noteEdit(fieldId, editedValue(reviewed.values[fieldId]!, value)); editField(review.stepId, fieldId, value); }}
      busy={busy || Boolean(pendingMentor) || awaitingReply || Boolean(liveOnly) || mentorExecutions.some(openOrganizer)}
      onConfirm={() => confirmation.submit(info)} onClose={confirmation.close}/>;
  }
  return (
    <WorkspaceFrame area="chat" notice={d?.runtimeMode==='staging_test'?'Staging 真实模型测试 · 未开放联网研究':'本地模拟 · 回复、保存与交接均为演示'} revealRight={reveal} rightOpen={resultOpen} onToggleRight={()=>setResultOpen(value=>!value)} right={<div className={resultStyles.panel}><header><h2>定位清单</h2><p>{snap.state==='draft'?'跟着对话自动记录；每一步核对后确认一次':'已确认的定位'}</p></header>
      <div className={resultStyles.body} ref={setResultBodyNode}><CaptureChecklist {...checklistProps()}/></div></div>}>
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
      {!planView && <>
      {d.accountRevision?.methodConflict&&<ChatInlineNotice tone="warning" alert>此修改草稿使用的方法与原正式版本不同，未自动合并或覆盖任何答案。请对照原正式内容核对当前草稿。
          <details><summary>查看原正式版本完整内容</summary>{Object.entries(d.accountRevision.sourceInformation as Record<string,{title:string;schema:Array<{id:string;title:string}>;values:Record<string,Information>}>).map(([id,part])=><section key={id}><h4>{part.title}</h4>{part.schema.map(field=><p key={field.id}>{field.title}：{part.values?.[field.id]?.value}</p>)}</section>)}</details>
      </ChatInlineNotice>}
      <nav aria-label="定位步骤" className={resultStyles.phaseStrip} style={{gridTemplateColumns:`repeat(${steps.length},minmax(0,1fr))`}}>
        {steps.map((step, index) => (
          <Button
            key={step.id}
            variant={selectedStep.id === step.id ? "default" : "outline"}
            aria-current={selectedStep.id === step.id ? "step" : undefined}
            disabled={
              busy || hasPendingConfirmation || hasPendingStepRequest ||
              (!d.accountRevision && firstPending >= 0 &&
                index > firstPending &&
                !snap.steps[step.id].valid)
            }
            onClick={() => setActiveStep(step.id)}
          >
            {snap.steps[step.id].valid ? "✓ " : `${index + 1} `}{step.title}
          </Button>
        ))}
      </nav>
      <section aria-label="当前定位步骤" className="space-y-4">
        {snap.workflow.steps.map((step: Step, index: number) => {
          if (step.id !== selectedStep.id) return null;
          const s = snap.steps[step.id];
          const sendLocked = busy || Boolean(history.data?.activeExecution) || openingSteps.includes(step.id) || Boolean(pendingMentor) ||
            hasPendingConfirmation || hasPendingStepRequest || free.busy;
          chatShown = true; // Its message list carries the page's notices.
          return (
            <article key="positioning-workspace" className={`${resultStyles.stepArticle} space-y-3`}>
              <h2 className="text-lg">{index + 1}. {step.title} {s.valid ? "· 已确认" : "· 待确认"}</h2>
              {manualEntry && (
                <div role="status" className="space-y-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
                  <p className="font-medium">直接填写完整策略</p>
                  <p className="text-sm text-[var(--text-secondary)]">每一步的全部信息都在右侧清单里。内容会自动保存；一步填好后核对并确认一次，再进入下一步，全程不会调用 Agent。</p>
                  <Button variant="outline" disabled={busy || hasPendingConfirmation || hasPendingStepRequest} onClick={() => setManualMentorEnabled(true)}>
                    信息不够，让 Agent 帮我补齐
                  </Button>
                  <p className="text-xs text-[var(--text-secondary)]">切换后会带着已保存内容进入同一草稿的导师对话，不会清空或要求机械重填。</p>
                </div>
              )}
              <div className={resultStyles.stepColumns}>
                <aside aria-label="全程导师聊天" className={`${resultStyles.mentorChat} space-y-3`}>
                  {manualEntry && <p className="rounded-lg bg-[var(--bg-secondary)] p-3 text-sm">你选择了结构化录入。Agent 当前未启动；直接填写右侧即可。</p>}
                  <div>
                    <p className="text-xs text-[var(--text-secondary)]">全程同一对话</p>
                    <h3 className="font-semibold">和导师一起聊，每一步核对确认一次</h3>
                  </div>
                  <div ref={attachChatScroll} onScroll={onChatScroll} role="log" aria-label="完整导师消息" aria-live="polite"
                    className="max-h-[55vh] min-h-56 space-y-3 overflow-y-auto overscroll-contain pr-2">
                    {mentorExecutions.length===0&&<div className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
                      <span className={resultStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/>Graylum · 增长顾问</span>
                      <p className={`mt-1 whitespace-pre-wrap break-words ${resultStyles.messageBody}`}>
                        {d.accountRevision ? "已保留原正式定位的全部步骤。请选择需要修改的部分；未变化且已确认的内容无需重新填写。修改保存为草稿，核对后可更新正式版本。" : "我会在同一个对话里陪你完成全部步骤。你聊到的信息会自动记到右侧清单的对应栏目，每一步齐了以后由你核对并确认一次。"}
                      </p>
                    </div>}
                    {mentorExecutions.map((execution, executionIndex) => {
                      const turn = mentorTurns.get(execution.executionId);
                      const turnStep = steps.find(candidate => candidate.id === turn?.stepId);
                      const turnLabel = turnStep ? ` · ${turnStep.title}` : "";
                      const parsed = readWorkflowMentorExecution(execution.body ?? execution.primaryBody, execution.summary, turn?.stepId ?? step.id, d.information);
                      const openingTurn = turn?.kind === "opening" || isOpeningInput(execution.input);
                      const live = liveReply?.executionId === execution.executionId ? liveReply : null;
                      const reply = mentorReplyDisplay({ ...execution, body: execution.body ?? execution.primaryBody,
                        legacyMessage: parsed.message, liveText: live?.text, liveCard: live?.card, stopLocal: stopLocal(execution.executionId),
                        active: execution.executionId === history.data?.activeExecution, busy: busy || awaitingReply });
                      const next = mentorExecutions[executionIndex + 1];
                      if (!next) { lastTurnNotice = showsTurnState(reply.notice); lastTurnText = reply.notice?.text ?? ""; }
                      const status = cardStatus({ isLatest: !next, turn, shown: { roundId: d.roundId, stepId: step.id },
                        reply: next ? { ...mentorTurns.get(next.executionId), input: isOpeningInput(next.input) ? null : next.input }
                          : pendingBubble && { ...pendingBubble, roundId: d.roundId } });
                      const cardLocked = !status.onShownStep || execution.state !== "completed" || sendLocked || snap.state !== "draft";
                      if (reply.card && !status.answered && !liveOnly && foldedCard !== execution.executionId) {
                        dock = <QuestionCardView key={execution.executionId} card={reply.card} disabled={cardLocked} docked
                          onAnswer={(input, optionIndex) => void ask(step, input, {executionId: execution.executionId, optionIndex})}
                          onOther={focusReply} onDismiss={() => setFoldedCard(execution.executionId)}/>;
                      }
                      return (
                        <div key={execution.executionId} data-execution-id={execution.executionId} className="space-y-2">
                          {/* The host opens the step itself: no fabricated user message. */}
                          {!openingTurn && (
                            <div data-message-role="user" className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
                              <span className="text-xs text-[var(--text-secondary)]">你{turnLabel}</span>
                              <p className={`mt-1 whitespace-pre-wrap break-words ${resultStyles.messageBody}`}>{execution.input ?? "内容暂不可用"}</p>
                            </div>
                          )}
                          {reply.text && <div data-message-role="assistant" className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
                            <span className={resultStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/>{openingTurn ? "导师主动引导" : "导师"}{turnLabel}</span>
                            <MessageMarkdown className={`mt-1 ${resultStyles.messageBody}`} text={reply.text} streaming={Boolean(live)}/>
                          </div>}
                          {/* Answered: gone. Open: docked. Folded: one line. */reply.card && !status.answered && foldedCard === execution.executionId
                            && <OpenQuestionRecord card={reply.card} onShow={() => setFoldedCard("")}/>}
                          {/* Polling follows a running turn; the retry is for one that stopped advancing. */}
                          <ChatNoticeList notices={[...payg.turnNotices(execution, busy), mentorTurnNotice(execution.executionId, reply.notice,
                            !busy && execution.executionId === history.data?.activeExecution && turnNeedsRetry(execution)
                            ? { onClick: () => void run(() => execute.mutateAsync({ executionId: execution.executionId })) } : null)]}/>
                        </div>
                      );
                    })}
                    {pendingBubble&&!mentorExecutions.some(e=>e.request?.requestId===pendingBubble.requestId)&&<div data-message-role="user" data-request-id={pendingBubble.requestId} className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
                      <span>你 · {steps.find(candidate => candidate.id === pendingBubble.stepId)?.title}</span>
                      <p className={`whitespace-pre-wrap ${resultStyles.messageBody}`}>{pendingBubble.input}</p><ChatPendingStatus sending={running}/></div>}
                  {liveOnly&&(liveOnly.text||!liveOnly.card)&&<div data-message-role="assistant" aria-label="导师正在回复" className="mr-4 rounded-xl border border-[var(--border-primary)] p-3"><span className={resultStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/>导师</span>{liveOnly.text?<MessageMarkdown className={`mt-1 ${resultStyles.messageBody}`} text={liveOnly.text} streaming/>:<p className={`mt-1 ${resultStyles.messageBody}`}>导师正在思考…</p>}</div>}
                  <ChatNoticeList notices={[...payg.blockedNotices(mentorExecutions, busy), ...mentorTailNotices({ livePhase: live.phase, stop: live.stopAction,
                    saving: hasUnsavedInformation, error, notice, freeError: free.error, replying: awaitingReply, lastTurnOpen: lastTurnNotice, lastTurnText,
                    recovery: recoveryNeedsUser[0] && !busy
                      ? { readable: recoveryNeedsUser[0].readable, onClick: () => void recoverPendingStep(recoveryNeedsUser[0]!.step) } : null })]}/>
                  </div>
                  {!manualEntry && snap.state === "draft" && !s.valid && <StepConfirmCard revision={!!d.accountRevision} onReview={() => openReview(step.id)}
                    title={step.title} info={d.information[step.id]} edits={infoEdits[step.id]} resuming={confirmation.envelopeState(step.id).kind === "valid"}
                    canConfirm={confirmableStep(step)} disabled={busy || hasPendingStepRequest} signal={d.stepConfirmation?.[step.id]} onEdit={highlightFields(step.id)}
                    onConfirm={() => confirmation.confirmNow(step.id, d.information[step.id], infoEdits[step.id], snap.steps)}/>}
                  <WorkComposer value={mentorInput} onChange={setMentorInput} label="给导师的回复" placeholder={OTHER_PLACEHOLDER} attachment={dock} maxLength={8000} disabled={snap.state!=="draft"} sendDisabled={sendLocked} onSend={skill=>{if(skill)void free.send(mentorInput,skill);else void ask(step);}}/>
                  <p className="text-xs text-[var(--text-secondary)]">
                    同一账号的步骤共用这条对话，未确认内容保留在草稿中。{d?.runtimeMode==='staging_test'?'当前使用真实模型，仅处理你提供的资料。':'当前为隔离模拟，不调用真实模型。'}
                  </p>
                </aside>
              </div>
              {s.valid && index === steps.length - 1 && (
                <div role="status" className={resultStyles.completionNotice}>
                  <h3>本步骤进度已完成</h3>
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
                <div className={resultStyles.stepNavigation}>
                  <Button variant="outline" disabled={busy || hasUnsavedInformation || hasPendingStepRequest}
                    onClick={() => setActiveStep(steps[index + 1].id)}>继续下一步</Button>
                </div>
              )}
            </article>
          );
        })}
      </section>
      {confirmation.review && reviewDialog(confirmation.review)}
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
      {!planView && d.accountRevision && snap.state === "draft" && nextReviewStep && <div role="status">
        <p>“{nextReviewStep.title}”还有修改的信息待确认。只需确认修改项，未修改内容沿用原确认。</p>
        <Button variant="outline" disabled={busy || hasUnsavedInformation || hasPendingConfirmation || hasPendingStepRequest}
          onClick={() => { setError(""); setActiveStep(nextReviewStep.id); }}>
          核对修改：{nextReviewStep.title}
        </Button>
      </div>}
      {!planView && <Button
        disabled={
          busy ||
          hasUnsavedInformation ||
          hasPendingConfirmation || hasPendingStepRequest || hasUnconfirmedRequired || (d.accountRevision ? Boolean(nextReviewStep) : steps.some((step) => !snap.steps[step.id].valid)) ||
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
      {!planView && read.data?.sessionId && <ReportEntry draftId={draftId} sessionId={read.data.sessionId}
        projectId={d.projectId} roundId={d.roundId} busy={busy || hasUnsavedInformation || hasPendingStepRequest}
        confirmed={!hasUnconfirmedRequired && !hasPendingConfirmation &&
        !(d.accountRevision ? nextReviewStep : steps.some((step) => !snap.steps[step.id].valid))} />}
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
      {!chatShown && <ChatNoticeList
        notices={[error && { id: "error", tone: "error", text: error }, notice && { id: "notice", tone: "warning", text: notice }]}/>}
    </div></main></WorkspaceFrame>
  );
}
