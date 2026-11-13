"use client";
import { type AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useMemo, use, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { WorkspaceFrame } from "@/components/opc/workspace-frame";
import { X } from "lucide-react";
import resultStyles from "@/components/opc/positioning-result.module.css";
import { WorkComposer, useFreeConversation } from '@/components/opc/work-composer';
import { createInformationAutosave, informationBaseKey, keepConflictingEdits, tabStorage, savedRead, stepView,
  type AutosaveIo, type SaveState } from "./information-autosave";
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
import { ChatInlineNotice, ChatNoticeList } from "@/components/chat/ChatInlineNotice";
import { PositioningHeader, PositioningResultPanel, PositioningStepStrip } from "@/components/chat-display/positioning-chrome";
import { MentorChatHeading, MentorChatLog, MentorLiveReply, MentorPendingMessage, MentorReply, MentorTurnGroup, MentorUserMessage,
  MentorWelcome } from "@/components/chat-display/mentor-messages";
import { useMentorLogScroll } from "./use-mentor-log-scroll";
import { mentorTailNotices, mentorTurnNotice, RETRY_PENDING_NOTICE, turnNeedsRetry, useOpeningFailureNotice } from "./mentor-notices";
import { useAutoStepRecovery, useOpeningGate } from "./use-step-recovery";
import { executionSettled } from "./step-recovery";
import { useLiveReply, useMentorTurnPath } from "./use-live-reply";
import { PublishFootnote, PublishNext, ReportEntry, reportPublishes } from "./report-panel";
import { DraftArchiveGate, ReadonlyDraftView, retryUnlessMissing } from './readonly-draft-view';
import { InformationExport } from "./InformationExport";
import { enterTopicWorkspace, topicsEntryShown } from "./topic-consent";
import { EXISTING_WELCOME } from "../start-entry";
import { isStepSummaryInput, offersStepSummary, STEP_SUMMARY_INPUT, STEP_SUMMARY_LABEL, stepSummaryRequest, summaryRefusal,
  summaryShown } from "./step-summary";
import { sameRequest, releaseRejectedAnswer, openingRequest, parseStepEnvelope, type MentorRequest,
  retainExecution, settleEnvelope, turnResultNotice, type MentorTurn, type MentorExecution } from "./mentor-turn";
import { checklistUpdatedInput, isOpeningInput, openingEntryKey } from "@repo/api/src/shared/opcQuestions";
import { clearSavedFields, freeAnswerSource, isHostAction, noteSavedFields, nudgeNotice, savedFields, shownInput } from "./checklist-nudge";
type Step = { id: string; title: string; dependsOn?: string[] };
import { type Information, type StepEnvelope } from "./confirm-envelope";
import { MentorTurnSteps } from "./mentor-turn-steps"; import { WorkspaceSkeleton } from "@/components/opc/workspace-skeleton";
import { ResearchSessionPanel, useResearchCalls } from "@/components/research/research-session";
/** The retained mentor request is either wrapped in `request` or legacy top-level. */
export default function PositioningDraft({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = use(params);
  return <DraftArchiveGate key={draftId} draftId={draftId}><PositioningDraftContent key={draftId} draftId={draftId}/></DraftArchiveGate>;
}
function PositioningDraftContent({draftId}:{draftId:string}){
  const router = useRouter();
  const utils = trpc.useUtils();
  const read = trpc.opc.read.useQuery({ draftId }, { retry: retryUnlessMissing });
  // The topics window keeps working on the version in effect while a revision is open (its workspace is bound to that version), so its
  // entry stays (staging validation #1269); only a positioning with neither a formal report nor a bound workspace has none.
  const topicWorkspace = trpc.opc.topicWorkspace.useQuery({ draftId },
    { enabled: Boolean(draftId && read.data && !read.data.conversationDeleted), staleTime: 30_000 });
  const library = trpc.opc.library.useQuery({search:'',from:null,to:null});
  const discussionAccounts = ((library.data?.businesses??[]) as Array<{accounts:Array<{strategyDraftId?:string;pendingStrategyDraftId?:string|null;displayName?:string;account:string;platform:string}>}>).flatMap(business=>business.accounts).filter(account=>account.pendingStrategyDraftId===draftId||account.strategyDraftId===draftId);
  const discussionAccount = discussionAccounts.length===1?discussionAccounts[0]:undefined;
  const list = trpc.opc.list.useQuery(), turnPath = useMentorTurnPath(read.data?.sessionId, draftId);
  const [pendingBubble,setPendingBubble]=useState<MentorRequest|null>(null);
  const [foldedCard,setFoldedCard]=useState(''); // Execution whose docked question card the user folded away.
  const mentorSendInFlight=useRef(false);
  /** One turn's events: a resumed execution passes its id, a new turn learns it from `admitted`. */
  const streamTurn=(open:()=>Promise<AsyncIterable<AgentTurnEvent>>,executionId?:string,onAdmitted?:(id:string)=>void)=>
    live.stream(open,{executionId,onAdmitted,onFinished:()=>void utils.credits.getBalance.invalidate(),
      onResult:result=>{const notice=turnResultNotice(result);if(notice)setError(notice);}});
  const execute={mutateAsync:(input:{executionId:string})=>turnPath.settled(input.executionId)};
  /** A mentor turn in one request: admission, then the same execution stream (AC-1). */
  const mentorTurn=(request:MentorRequest,onAdmitted?:(id:string)=>void)=>
    streamTurn(turnPath.open(request,read.data),undefined,onAdmitted);
  const information = trpc.opc.information.useMutation();
  const [infoEdits, setInfoEdits] = useState<
    Record<string, Record<string, Information>>
  >({});
  const revise = trpc.opc.revise.useMutation();
  const change = trpc.workbench.execute.useMutation();
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
  const [error, setError] = useState("");
  const history = turnPath.history;
  const research = useResearchCalls(read.data?.sessionId);
  const live = useLiveReply(draftId, history.data, research.observe), liveReply = live.reply, stopLocal = live.stopLocal, stale = live.reopenGraceOver;
  const [activeStep, setActiveStep] = useState<string | null>(null);
  // State, not a ref: on a client-side return cached history exists before the log mounts.
  const [mentorInput, setMentorInput] = useState("");
  const free=useFreeConversation();
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
        executionId: string; state: string; request?: MentorRequest | null;
        billing?: {closed?: boolean; cancelRequested?: boolean} | null;
      }) => execution.state === "cost_pending" && execution.billing?.closed === true &&
        execution.billing.cancelRequested === true && execution.executionId !== history.data?.activeExecution &&
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
    onSaved: (stepId, fieldIds) => noteSavedFields(sessionStorage, draftId, stepId, fieldIds),
  };
  const [autosave] = useState(() => createInformationAutosave(() => autosaveIo.current));
  const flushInformation = autosave.flush;
  useEffect(() => {
    // Mirror `infoEdits` before scheduling: the scheduler reads the ref.
    infoEditsRef.current = infoEdits;
    if (hydratedDraft !== draftId || composing.current || read.data?.conversationDeleted) return; // read-only: no save
    autosave.schedule();
    return autosave.cancel;
  }, [draftId, hydratedDraft, infoEdits, read.data?.conversationDeleted]);
  /**
   * The explicit "现在生成第一周选题吗？" ask. It cannot start work on its own.
   */
  const [consentOpen, setConsentOpen] = useState(false);
  const consentDialog = useRef<HTMLDivElement>(null);
  useEffect(() => { if (consentOpen) consentDialog.current?.focus(); }, [consentOpen]);
  /** The bound topic workspace of this draft (the consented entry target). */
  const bindTopic = trpc.opc.consentTopicWorkspace.useMutation();
  const hasUnsavedInformation = Object.keys(infoEdits).length > 0;
  const d = useMemo(() => turnPath.draft(read.data), [read.data, turnPath.turns]), // eslint-disable-line react-hooks/exhaustive-deps
    snap = d?.snapshot;
  /** Utterances the mentor classified as non-answers in one step: never confirmed as content. */
  function nonAnswersFor(stepId: string) {
    const turns = new Map(((d?.turns ?? []) as MentorTurn[]).map(turn => [turn.executionId, turn]));
    return ((history.data?.executions ?? []) as MentorExecution[])
      .filter(execution => turns.get(execution.executionId)?.stepId === stepId)
      .map(execution => readWorkflowMentorExecution(execution.body ?? execution.primaryBody, execution.summary, stepId,
        d.information).inputKind === "answer" || isHostAction(execution.input) ? "" : execution.input ?? "")
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
      const flow = (snap?.workflow.steps ?? []) as Step[], index = flow.findIndex(step => step.id === stepId), next = flow[index + 1];
      if (!d?.accountRevision && index >= 0 && next) { gate.grant(next.id, d?.roundId ?? null); setActiveStep(next.id); }
    },
  });
  const captureResolve = trpc.opc.captureResolve.useMutation(), capturePending = trpc.opc.capturePending.useMutation();
  const updates = useCaptureResolve({ draftId, active: hydratedDraft === draftId && snap?.state === "draft" && !d?.conversationDeleted,
    refetch: () => read.refetch(), flush: flushInformation, setError,
    resolve: input => captureResolve.mutateAsync(input), pending: input => capturePending.mutateAsync(input) });
  // `prepareStep`/`execute`/`mentorTurn` are deliberately excluded: the Agent's own
  // opening uses them, and it must never disable the form the user is filling in. Every
  // user-initiated use of them runs inside `run()` (or a named flag), which is
  // what actually gates the controls.
  const busy = bindTopic.isPending ||
    running || confirmation.confirming || Boolean(updates.resolving) ||
    revise.isPending ||
    change.isPending;
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
    setInfoEdits(local.infoEdits ?? {});
    setHydratedDraft(draftId);
  }, [draftId]);
  useEffect(() => {
    if (hydratedDraft !== draftId) return;
    try {
      // Merge rather than replace: the buffer may carry entries an earlier version of this page left behind.
      const raw = sessionStorage.getItem("opc-edit:" + draftId);
      const previous = raw ? (JSON.parse(raw) ?? {}) : {};
      sessionStorage.setItem(
        "opc-edit:" + draftId,
        JSON.stringify({
          ...previous,
          infoEdits,
          activeStep,
          mentorInput,
        }),
      );
    } catch {
      /* A malformed local buffer must not break persistence. */
    }
    const warn = (e: BeforeUnloadEvent) => {
      if (Object.keys(infoEdits).length) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [
    draftId,
    hydratedDraft,
    infoEdits,
    activeStep,
    mentorInput,
  ]);
  useEffect(() => {
    if (hydratedDraft !== draftId || activeStep || !snap) return;
    const initial =
      snap.workflow.steps.find((step: Step) => !snap.steps[step.id].valid) ??
      snap.workflow.steps[0];
    setActiveStep(initial.id);
  }, [draftId, hydratedDraft, activeStep, snap]);
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
  const [openingSteps, setOpeningSteps] = useState<string[]>([]), gate = useOpeningGate(draftId);
  const [notice, setNotice] = useState(""), openingFailed = useOpeningFailureNotice(d, history.data?.executions, notice, setNotice);
  useEffect(() => {
    if (hydratedDraft !== draftId || !d || !history.data || d.conversationDeleted || !turnPath.ready) return; // read-only; path undecided
    // A manual draft (我已有定位, R15) opens too: the mentor asks for the existing positioning first.
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
    if (turnPath.stepOpened(turns, step.id, d.roundId)) return gate.clear();
    // A retained explicit mentor request already owns this step's next turn.
    if (sessionStorage.getItem("opc-step:" + draftId + ":" + step.id)) return;
    if (sessionStorage.getItem("opc-confirm-step:" + draftId + ":" + step.id)) return;
    const key = openingEntryKey(draftId, d.roundId, step.id, question.id);
    if (autoOpening.current.has(key) || !gate.admit(step.id, d.roundId, stepIndex === 0)) return;
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
        setNotice(openingFailed(step.id));
      } finally {
        openingInFlight.current.delete(step.id);
        setOpeningSteps([...openingInFlight.current]);
      }
    })();
  }, [hydratedDraft, draftId, d, history.data, activeStep, openingFailed, turnPath.ready, gate.asked]);
  const recoveryNeedsUser = useAutoStepRecovery({ history: history.data, historyFailed: history.isError, draftId, recover: recoverPendingStep,
    steps: (d?.snapshot.workflow.steps ?? []) as Step[],
    ready: hydratedDraft === draftId, blocked: busy || openingSteps.length > 0 });
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
        if (releaseRejectedAnswer(sessionStorage, key, request.requestId, cause, text => setMentorInput(old => old.trim() ? old : text), !!executionId)) {
          setPendingBubble(old => old?.requestId === request.requestId ? null : old); live.clear();
          await Promise.all([read.refetch(), history.refetch()]);
        }
        throw summaryRefusal(request, cause);
      });
    // Read the turn binding and its execution together while the retained
    // envelope still blocks automatic opening. Clearing the envelope first
    // lets that effect race an explicit first message on a manual draft.
    const [draftRead, historyRead] = await Promise.all([read.refetch(), history.refetch()]);
    if (draftRead.error || !draftRead.data || historyRead.error || !historyRead.data)
      throw new Error('OPC_MENTOR_READBACK_UNAVAILABLE');
    // A running execution keeps envelope and bubble until a resume sees a terminal result; a Q1 refusal refills the box.
    if (!settleEnvelope(sessionStorage, key, request.requestId, executionId, result)) return;
    setPendingBubble(old=>old?.requestId===request.requestId?null:old);
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
  async function ask(step: Step, inputOverride?: string, answerSource?: MentorRequest["answerSource"], researchRefreshId?: string) {
    if(mentorSendInFlight.current)return;
    const key = "opc-step:" + draftId + ":" + step.id;
    if (sessionStorage.getItem(key)) {
      // A retained envelope still owns this step. Never create a second
      // identity; the explicit recovery control resumes the original request.
      setError("上一条发给 AI 教练的内容仍在核对。请先点“重试”恢复，不会重复发送。");
      return;
    }
    if(running||openingInFlight.current.size||history.data?.activeExecution)return;
    const input=(inputOverride??mentorInput).trim();if(!input)return;
    const latest = mentorExecutions.at(-1), sourceTurn = latest && mentorTurns.get(latest.executionId);
    const summary = inputOverride === STEP_SUMMARY_INPUT; // R16: only the button, never typed text; no card, no field.
    // Typing instead of choosing still answers the newest card of this step and round (a refresh answers none).
    answerSource = freeAnswerSource({ answerSource, input, researchRefreshId, latest, sourceTurn, roundId: d.roundId, stepId: step.id });
    const questionId = focusField(d.information[step.id]);
    const fixed:StepEnvelope={request:summary?stepSummaryRequest(draftId,step.id,crypto.randomUUID()):{...(answerSource ? {answerSource} : {}),
      ...(researchRefreshId ? {researchRefreshId} : {}),
      draftId,stepId:step.id,purpose:'mentor',requestId:crypto.randomUUID(),input,questionId,organizeAfter:true}};
    sessionStorage.setItem(key,JSON.stringify(fixed));
    mentorSendInFlight.current=true;
    setPendingBubble(fixed.request);if(inputOverride===undefined)setMentorInput('');
    chatFollow.current=true;
    // The nudge is cleared after the flush: this message carries those saved edits too.
    try{await run(async()=>{await flushInformation(step.id);clearSavedFields(sessionStorage,draftId);await resumeStepEnvelope(step,fixed);});}
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
  /**
   * The explicit consent that may start the first-week topic generation. A fresh intent enters the bound topic workspace: the
   * server freezes the confirmed version, the pinned method revision and its declared topic resources, and refuses when the
   * method declares none. Nothing is dispatched here — the workspace's own turn is the paid action.
   */
  async function consentPlan() {
    if (!d || hasUnsavedInformation) return;
    // The server checks the displayed source under the same lock as binding/consent; no cached read permits a jump.
    const outcome = await enterTopicWorkspace({ draftId, sourceVersionId: d.report?.id, bind: input => bindTopic.mutateAsync(input),
      push: path => router.push(path) });
    setConsentOpen(false);
    if (!outcome.entered) setNotice(outcome.notice);
  }
  function retainConflictingInput(stepId: string) {
    const conflict=informationConflicts[stepId], edited=infoEditsRef.current[stepId]; if (!conflict || !edited) return;
    autosaveIo.current.setEdits(stepId, keepConflictingEdits(tabStorage, draftId, stepId, edited, conflict));
    setInformationConflicts(old=>{const next={...old};delete next[stepId];return next;});
  }
  if (read.isLoading || hydratedDraft !== draftId) return <WorkspaceSkeleton area="chat" label="定位读取中" />;
  if (read.error || !d) return <main className="p-6" role="alert">
    {read.error?.data?.code==="NOT_FOUND"?"找不到这份定位，它可能已被删除。":"无法读取这份定位，请检查登录和访问权限。"}<Link href="/app/positioning">返回定位列表</Link></main>;
  if (d.conversationDeleted) return <ReadonlyDraftView draftId={draftId} draft={d}/>; // Owner 2026-10-14: read-only after deletion.
  const steps: Step[] = snap.workflow.steps;
  const firstPending = steps.findIndex((step) => !snap.steps[step.id].valid);
  /** 我已有定位 (R15): the same Agent workspace; only the wording differs. */
  const existingEntry = d.mode === "manual" && !d.accountRevision;
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
  const settledTurns = mentorExecutions.filter(execution => executionSettled(history.data, execution.executionId)).length;
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
  const hasPendingStepRequest = pendingStepRequests.length > 0, awaitingReply = hasPendingStepRequest && !recoveryNeedsUser.length;
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
  function confirmableStep(step: Step) { if (pendingMentor || awaitingReply || liveOnly) return false;
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
      manual: false, locked, saveState, highlight, conflicts: informationConflicts, resolving: updates.resolving,
      confirmable: stepId => confirmableStep(steps.find(step => step.id === stepId)!),
      confirmation: confirmation.displayState,
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
      busy={busy || Boolean(pendingMentor) || awaitingReply || Boolean(liveOnly)}
      loading={review.loading} loadError={review.loadError} onConfirm={() => confirmation.submit(info)} onClose={confirmation.close}/>;
  }
  return (
    <WorkspaceFrame area="chat" notice={d?.runtimeMode==='staging_test'?'Staging 真实模型测试':d?.runtimeMode==='production'?undefined:'本地模拟 · 回复、保存与交接均为演示'} revealRight={reveal} turnBusy={turnPath.creditsBusy} rightOpen={resultOpen} onToggleRight={()=>setResultOpen(value=>!value)} right={<PositioningResultPanel
      subtitle={snap.state==='draft'?'跟着对话自动记录；每一步核对后确认一次':'已确认的定位'} bodyRef={setResultBodyNode}><CaptureChecklist {...checklistProps()}/></PositioningResultPanel>}>
    <main className={`${resultStyles.workspaceMain} ${resultStyles.conversationPage} h-full w-full overflow-y-auto text-[var(--text-primary)]`}><div className={resultStyles.workspaceContent}>
      <PositioningHeader
        title={discussionAccount ? (discussionAccount.displayName??discussionAccount.account)+" · 定位策略"
          : existingEntry ? "核对已有定位" : "我的定位分析"}
        status={(discussionAccount?discussionAccount.platform:'整体规划')+(snap.state==='published'?' · 已确认':' · 进行中')}
        onWorkInfo={()=>setWorkInfoOpen(true)} showExpand={!resultOpen} onExpand={()=>setResultOpen(true)}/>
      {workInfoOpen&&<div className={resultStyles.infoBackdrop} onMouseDown={event=>{if(event.target===event.currentTarget)setWorkInfoOpen(false);}}><section role="dialog" aria-modal="true" aria-label="工作信息" className={resultStyles.infoDialog}><header><h2>工作信息</h2><button type="button" aria-label="关闭工作信息" onClick={()=>setWorkInfoOpen(false)}>×</button></header><p>当前工作：{existingEntry?'已有定位核对':'定位分析'}</p><p>状态：{snap.state==='published'?'定位已确认':'定位进行中'}</p><p>定位讨论、待确认修改与历史版本留在原工作；查看不会确认或保存。</p><footer><button type="button" onClick={()=>{void read.refetch();setWorkInfoOpen(false);}}>重新读取状态</button><Link href="/app/positioning">新任务与账号</Link></footer></section></div>}
      <>
      {d.accountRevision?.methodConflict&&<ChatInlineNotice tone="warning" alert>此修改草稿使用的方法与原正式版本不同，未自动合并或覆盖任何答案。请对照原正式内容核对当前草稿。
          <details><summary>查看原正式版本完整内容</summary>{Object.entries(d.accountRevision.sourceInformation as Record<string,{title:string;schema:Array<{id:string;title:string}>;values:Record<string,Information>}>).map(([id,part])=><section key={id}><h4>{part.title}</h4>{part.schema.map(field=><p key={field.id}>{field.title}：{part.values?.[field.id]?.value}</p>)}</section>)}</details>
      </ChatInlineNotice>}
      <PositioningStepStrip selectedId={selectedStep.id} onSelect={setActiveStep} steps={steps.map((step, index) => ({
        id: step.id, title: step.title, valid: Boolean(snap.steps[step.id].valid),
        disabled: busy || hasPendingConfirmation || hasPendingStepRequest ||
          (!d.accountRevision && firstPending >= 0 && index > firstPending && !snap.steps[step.id].valid),
      }))}/>
      <section aria-label="当前定位步骤" className="space-y-4">
        {snap.workflow.steps.map((step: Step, index: number) => {
          if (step.id !== selectedStep.id) return null;
          const s = snap.steps[step.id];
          const sendLocked = busy || Boolean(history.data?.activeExecution) || openingSteps.includes(step.id) || Boolean(pendingMentor) ||
            hasPendingConfirmation || hasPendingStepRequest || free.busy, replying = sendLocked && !recoveryNeedsUser.length;
          const nudged = s.valid || infoEdits[step.id] ? [] : savedFields(sessionStorage, draftId, step.id, d.information[step.id].schema);
          chatShown = true; // Its message list carries the page's notices.
          return (
            <article key="positioning-workspace" className={`${resultStyles.stepArticle} space-y-3`}>
              <h2 className="text-lg">{index + 1}. {step.title} {s.valid ? "· 已确认" : "· 待确认"}</h2>
              <div className={resultStyles.stepColumns}>
                <aside aria-label="全程 AI 教练聊天" className={`${resultStyles.mentorChat} space-y-3`}>
                  <MentorChatHeading/>
                  <MentorChatLog logRef={attachChatScroll} onScroll={onChatScroll}>
                    {mentorExecutions.length===0&&<MentorWelcome text={existingEntry ? EXISTING_WELCOME : d.accountRevision
                      ? "已保留原正式定位的全部步骤。请选择需要修改的部分；未变化且已确认的内容无需重新填写。修改保存为草稿，核对后可更新正式版本。"
                      : "我会在同一个对话里陪你完成全部步骤。你聊到的信息会自动记到右侧清单的对应栏目，每一步齐了以后由你核对并确认一次。"}/>}
                    {mentorExecutions.map((execution, executionIndex) => {
                      const turn = mentorTurns.get(execution.executionId);
                      const turnStep = steps.find(candidate => candidate.id === turn?.stepId);
                      const turnLabel = turnStep ? ` · ${turnStep.title}` : "";
                      const parsed = readWorkflowMentorExecution(execution.body ?? execution.primaryBody, execution.summary, turn?.stepId ?? step.id, d.information);
                      const openingTurn = turn?.kind === "opening" || isOpeningInput(execution.input);
                      const summaryTurn = isStepSummaryInput(execution.input);
                      const live = liveReply?.executionId === execution.executionId ? liveReply : null;
                      const next = mentorExecutions[executionIndex + 1];
                      const reply = mentorReplyDisplay({ ...execution, body: execution.body ?? execution.primaryBody, earlier: Boolean(next),
                        legacyMessage: parsed.message, liveText: live?.text, liveCard: live?.card, stopLocal: stopLocal(execution.executionId),
                        active: execution.executionId === history.data?.activeExecution, busy: busy || (awaitingReply && Boolean(liveReply)), stale });
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
                        <MentorTurnGroup key={execution.executionId} executionId={execution.executionId}>
                          {/* The host opens the step itself: no fabricated user message. */}
                          {!openingTurn && <MentorUserMessage stepLabel={turnLabel} text={shownInput(execution.input) ?? "内容暂不可用"}/>}
                          <MentorTurnSteps live={live} reply={reply} execution={execution} calls={research.of(execution.executionId)} stale={stale}/>
                          {reply.text && <MentorReply kind={summaryTurn ? "summary" : openingTurn ? "opening" : "reply"} stepLabel={turnLabel}
                            text={reply.text} live={Boolean(live)} result={execution}
                            summaryHint={Boolean(summaryTurn && !next && !s.valid && turn?.stepId === step.id && summaryShown(execution))}/>}
                          {/* Answered: gone. Open: docked. Folded: one line. */reply.card && !status.answered && foldedCard === execution.executionId
                            && <OpenQuestionRecord card={reply.card} onShow={() => setFoldedCard("")}/>}
                          {/* Polling follows a running turn; the retry is for one that stopped advancing. */}
                          <ChatNoticeList notices={[mentorTurnNotice(execution.executionId, reply.notice,
                            !busy && execution.executionId === history.data?.activeExecution && turnNeedsRetry(execution, stale)
                            ? { onClick: () => void run(() => execute.mutateAsync({ executionId: execution.executionId })) } : null)]}/>
                        </MentorTurnGroup>
                      );
                    })}
                    {pendingBubble&&!mentorExecutions.some(e=>e.request?.requestId===pendingBubble.requestId)&&<MentorPendingMessage
                      requestId={pendingBubble.requestId} stepTitle={steps.find(candidate => candidate.id === pendingBubble.stepId)?.title}
                      text={shownInput(pendingBubble.input)} sending={running} accepted={Boolean(stepEnvelopeFor(pendingBubble.stepId)?.parsed?.executionId)}/>}
                  {liveOnly && <MentorTurnSteps live={liveOnly} reply={liveOnly} calls={research.of(liveOnly.executionId)}/>}
                  {liveOnly&&(liveOnly.text||!liveOnly.card)&&<MentorLiveReply text={liveOnly.text}/>}
                  {read.data?.sessionId && <ResearchSessionPanel sessionId={read.data.sessionId} settledTurns={settledTurns} {...research.panel}
                    disabled={replying ? "busy" : sendLocked || snap.state !== "draft" ||
                      mentorTurns.get(mentorExecutions.at(-1)?.executionId ?? "")?.stepId !== step.id}
                    onSend={(text, refreshId) => ask(step, text, undefined, refreshId)}/>}
                  <ChatNoticeList notices={[...turnPath.notices(open => void run(() => streamTurn(open))),
                    nudgeNotice(nudged, () => void ask(step, checklistUpdatedInput(nudged)), sendLocked, hasPendingStepRequest),
                    ...mentorTailNotices({ livePhase: live.phase, stop: live.stopAction,
                    saving: hasUnsavedInformation, error, notice, freeError: free.error,
                    opening: gate.offer(step.id, openingSteps.length === 0 && !busy), replying: awaitingReply, lastTurnOpen: lastTurnNotice, lastTurnText,
                    recovery: recoveryNeedsUser[0] && !busy
                      ? { readable: recoveryNeedsUser[0].readable, onClick: () => void recoverPendingStep(recoveryNeedsUser[0]!.step) } : null })]}/>
                  </MentorChatLog>
                  {snap.state === "draft" && !s.valid && <StepConfirmCard stays={!!d.accountRevision || index === steps.length - 1}
                    title={step.title} info={d.information[step.id]} edits={infoEdits[step.id]} resuming={confirmation.displayState(step.id) === "valid"}
                    stepId={step.id} canConfirm={confirmableStep(step)} disabled={busy || hasPendingStepRequest} signal={d.stepConfirmation?.[step.id]}
                    onConfirm={settled => confirmation.confirmNow(step.id, d.information[step.id], infoEdits[step.id], snap.steps, settled)}
                    onEdit={highlightFields(step.id)} onReview={() => openReview(step.id)}/>}
                  {snap.state === "draft" && !s.valid && offersStepSummary(mentorExecutions.filter(execution => {
                    const turn = mentorTurns.get(execution.executionId);
                    return turn?.stepId === step.id && (!Object.hasOwn(turn, "roundId") || turn.roundId === d.roundId);
                  })) && <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" disabled={sendLocked} onClick={() => void ask(step, STEP_SUMMARY_INPUT)}>{STEP_SUMMARY_LABEL}</Button>
                    <span className="text-xs text-[var(--text-secondary)]">让 AI 教练先整理这一步的小结，还缺什么会如实列出；确认仍由你来点。</span>
                  </div>}
                  <WorkComposer references={false} value={mentorInput} onChange={setMentorInput} label="给 AI 教练的回复" placeholder={OTHER_PLACEHOLDER} attachment={dock} maxLength={8000} disabled={snap.state!=="draft"} sendDisabled={sendLocked} onSend={skill=>{if(skill)void free.send(mentorInput,skill);else void ask(step);}}/>
                  <p className="text-xs text-[var(--text-secondary)]">
                    同一账号的步骤共用这条对话，未确认内容保留在草稿中。{d?.runtimeMode==='staging_test'||d?.runtimeMode==='production'?'当前使用真实模型，仅处理你提供的资料。':'当前为隔离模拟，不调用真实模型。'}
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
                        : <PublishNext workflow={snap.workflow}/>}
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
      </>
      {<footer className={resultStyles.publishBar}><div>
      <InformationExport draftId={draftId} current={d}/>
      {snap.state === "published" && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await revise.mutateAsync({
                draftId,
                requestId: crypto.randomUUID(),
                expectedRoundId: d.roundId,
              });
            })
          }
        >
          修订定位，保留原版本
        </Button>
      )}
      {d.accountRevision && snap.state === "draft" && nextReviewStep && <div role="status">
        <p>“{nextReviewStep.title}”还有修改的信息待确认。只需确认修改项，未修改内容沿用原确认。</p>
        <Button variant="outline" disabled={busy || hasUnsavedInformation || hasPendingConfirmation || hasPendingStepRequest}
          onClick={() => { setError(""); setActiveStep(nextReviewStep.id); }}>
          核对修改：{nextReviewStep.title}
        </Button>
      </div>}
      {!reportPublishes(snap.workflow) && <Button
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
      {snap.state === "published" && (
        <Button variant="outline"
          disabled={busy || hasUnsavedInformation || hasPendingStepRequest}
          onClick={() => setConsentOpen(true)}
        >
          继续生成第一周选题
        </Button>
      )}
      {read.data?.sessionId && <ReportEntry draftId={draftId} moduleId={read.data.moduleId}
        sessionId={read.data.sessionId} published={snap.state === "published"}
        projectId={d.projectId} roundId={d.roundId} report={d.report} busy={busy || hasUnsavedInformation || hasPendingStepRequest}
        onTopics={() => void run(async () => { if ((await read.refetch()).isError) throw new Error("OPC_UNAVAILABLE"); })
          .then(failure => { if (!failure) setConsentOpen(true); })} // Only with the finalized version read back.
        confirmed={!hasUnconfirmedRequired && !hasPendingConfirmation && !(d.accountRevision ? nextReviewStep : steps.some(x => !snap.steps[x.id].valid))} />}
      </div><p><PublishFootnote workflow={snap.workflow}/></p>
      {topicsEntryShown(d.report?.available, topicWorkspace.data?.bound) && <Link href={`/app/positioning/${draftId}/topics`}>进入选题工作对话 →</Link>}
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
      {!chatShown && <ChatNoticeList
        notices={[error && { id: "error", tone: "error", text: error }, notice && { id: "notice", tone: "warning", text: notice }]}/>}
    </div></main></WorkspaceFrame>
  );
}
