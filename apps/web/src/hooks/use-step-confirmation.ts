/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useEffect, useRef, useState } from "react";
import {
  isConfirmStepEnvelope, type ConfirmEnvelopeState, type ConfirmStepEnvelope, type Information,
} from "@/app/positioning/[draftId]/confirm-envelope";
import { isDefiniteConfirmConflict } from "@/app/positioning/[draftId]/confirm-conflict";
import {
  sameVisibleStep, stepBody, stepConfirmationValues, visibleStep, withEdits,
  type FieldValue, type ReviewProblem, type StepInformation, type VisibleStep,
} from "@/components/opc/capture-state";

type StepState = { version: number; reviewVersion: number; valid: boolean; body?: string; evidenceIds: string[] };
export type ConfirmRead = {
  projectId: string;
  roundId: string;
  accountRevision?: unknown;
  information: Record<string, StepInformation>;
  snapshot: { steps: Record<string, StepState> };
};
type Step = { id: string; title: string; dependsOn?: string[] };
type Transition = Record<string, unknown> & { expectedVersion: number };

export type StepConfirmationDeps = {
  draftId: string;
  ready: boolean;
  steps: readonly Step[];
  refetch: () => Promise<{ data?: ConfirmRead | null; error?: unknown }>;
  /** Waits for every queued autosave of the step. */
  flush: (stepId: string) => Promise<void>;
  pendingEdits: (stepId: string) => Record<string, FieldValue> | undefined;
  /** Forget the step's local edits once they are exactly the confirmed ones. */
  releaseEdits: (stepId: string, editingSnapshot: string) => void;
  writeInformation: (input: ConfirmStepEnvelope["information"]) => Promise<unknown>;
  transition: (input: Transition) => Promise<unknown>;
  /** The page's busy wrapper: it refreshes the reads and reports failures. */
  run: (fn: () => Promise<unknown>) => Promise<unknown>;
  nonAnswers: (stepId: string) => string[];
  onConfirmed: (stepId: string) => void;
  setError: (message: string) => void;
  setRunning: (running: boolean) => void;
};

export const confirmKey = (draftId: string, stepId: string) => "opc-confirm-step:" + draftId + ":" + stepId;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
/** What the confirmation phases need from the page; plain functions so they can be tested. */
export type ConfirmationIo = Pick<StepConfirmationDeps, "draftId" | "refetch" | "flush" | "pendingEdits" | "releaseEdits" |
  "writeInformation" | "transition" | "onConfirmed"> & { storage: Storage };
async function readConfirmation(io: Pick<ConfirmationIo, "refetch">) {
  const result = await io.refetch();
  if (result.error || !result.data) throw new Error("OPC_UNAVAILABLE");
  return result.data;
}
const REVIEW_CHANGED = "OPC_STEP_REVIEW_CHANGED";
const sameInformation = (a: Information | undefined, b: Information | undefined) =>
  a?.value === b?.value && a?.status === b?.status && a?.nature === b?.nature;

/** Runs the retained phases. The same code finishes a new or a legacy envelope. */
export async function executeConfirmation(io: ConfirmationIo, step: Step, request: ConfirmStepEnvelope) {
  const k = confirmKey(io.draftId, step.id);
  const readCurrent = () => readConfirmation(io);
  if (request.phase === "information") {
    await io.writeInformation(request.information);
    request.phase = "save";
    io.storage.setItem(k, JSON.stringify(request));
    io.releaseEdits(step.id, request.editingSnapshot);
  }
  // A legacy single-question envelope that did not finish its step stops here.
  if (request.finishStep !== false && request.phase === "save") {
    if (request.save.expectedVersion === null) {
      const current = await readCurrent();
      if (Object.keys(request.values).some(id => !sameInformation(current.information[step.id]?.values?.[id], request.values[id])))
        throw new Error("OPC_INFORMATION_CONFLICT");
      request.save.expectedVersion = current.snapshot.steps[step.id]!.version;
      request.save.evidenceIds = current.snapshot.steps[step.id]!.evidenceIds;
      io.storage.setItem(k, JSON.stringify(request));
    }
    await io.transition({ ...request.save, expectedVersion: request.save.expectedVersion! });
    request.phase = "confirm";
    io.storage.setItem(k, JSON.stringify(request));
  }
  if (request.finishStep !== false && request.phase === "confirm") {
    let send = true;
    if (request.confirm.expectedVersion === null) {
      const current = await readCurrent(), state = current.snapshot.steps[step.id]!;
      if (state.body !== request.save.body ||
          Object.keys(request.values).some(id => !sameInformation(current.information[step.id]?.values?.[id], request.values[id])))
        throw new Error("OPC_INFORMATION_CONFLICT");
      // An account revision may save an edited step before its upstream steps are confirmed.
      if (current.accountRevision && (step.dependsOn ?? []).some(id => !current.snapshot.steps[id]?.valid)) send = false;
      else {
        request.confirm.expectedVersion = state.version;
        request.confirm.expectedReviewVersion = state.reviewVersion;
        io.storage.setItem(k, JSON.stringify(request));
      }
    }
    if (send) await io.transition({ ...request.confirm, expectedVersion: request.confirm.expectedVersion!,
      expectedReviewVersion: request.confirm.expectedReviewVersion! });
  }
  const current = await readCurrent();
  io.storage.removeItem(k);
  if (request.finishStep !== false && current.snapshot.steps[step.id]?.valid) io.onConfirmed(step.id);
}

/**
 * Versions of the steps this one depends on (transitively). An upstream edit invalidates the
 * step without touching its own values; the step's own reviewVersion cannot show that, since
 * the user's own autosave and the information phase raise it too.
 */
export function upstreamVersions(steps: readonly Step[], stepId: string, state: Record<string, { version: number }>) {
  const result: Record<string, number> = {}, queue = [...(steps.find(item => item.id === stepId)?.dependsOn ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (Object.hasOwn(result, id) || !state[id]) continue;
    result[id] = state[id].version;
    queue.push(...(steps.find(item => item.id === id)?.dependsOn ?? []));
  }
  return result;
}

/**
 * Before the first phase, the server content must still be exactly what the user
 * reviewed (their own edits included), and no step it depends on may have changed.
 * Anything else stops with the fresh content.
 */
export async function prepareConfirmation(io: ConfirmationIo, step: Step, info: StepInformation, reviewed: VisibleStep,
  values: Record<string, FieldValue>, upstream: Record<string, number>, steps: readonly Step[],
): Promise<{ changed: VisibleStep; upstream: Record<string, number> } | { envelope: ConfirmStepEnvelope }> {
  await io.flush(step.id);
  const current = await readConfirmation(io);
  const now = visibleStep(current.information[step.id]), nowUpstream = upstreamVersions(steps, step.id, current.snapshot.steps);
  const upstreamMoved = Object.keys({ ...upstream, ...nowUpstream }).some(id => upstream[id] !== nowUpstream[id]);
  if (io.pendingEdits(step.id) || upstreamMoved || !sameVisibleStep(reviewed, now)) return { changed: now, upstream: nowUpstream };
  const state = current.snapshot.steps[step.id]!;
  const envelope: ConfirmStepEnvelope = {
    phase: "information", finishStep: true, values, editingSnapshot: JSON.stringify(null),
    information: { draftId: io.draftId, stepId: step.id, requestId: crypto.randomUUID(), expectedVersion: state.version, values },
    save: { action: "save", projectId: current.projectId, roundId: current.roundId, requestId: crypto.randomUUID(),
      stepId: step.id, expectedVersion: null, body: stepBody(info.schema, values), evidenceIds: state.evidenceIds },
    confirm: { action: "confirm", projectId: current.projectId, roundId: current.roundId, requestId: crypto.randomUUID(),
      stepId: step.id, expectedVersion: null, expectedReviewVersion: null },
  };
  io.storage.setItem(confirmKey(io.draftId, step.id), JSON.stringify(envelope));
  return { envelope };
}

/** What the dialog shows and the confirmation compares: baseline, this dialog's edits, then any unsaved edit. */
export function reviewedStep(review: { baseline: VisibleStep; edits: Record<string, FieldValue> },
  pending?: Record<string, FieldValue>) {
  return withEdits(withEdits(review.baseline, review.edits), pending);
}

/** `touched`: deferrals the user switched in this dialog; every other one follows the reviewed content. */
/** `edits`: fields typed in this dialog, kept after their autosave clears the page's unsaved edits. */
type Review = { stepId: string; baseline: VisibleStep; upstream: Record<string, number>; edits: Record<string, FieldValue>;
  deferred: Set<string>; touched: Set<string>; problems: ReviewProblem[]; changed: boolean;
  loading?: boolean; loadError?: boolean };

/** Deferrals after the review baseline is refreshed: the new content's own, except the ones the user chose here. */
export function refreshedDeferrals(baseline: VisibleStep, deferred: ReadonlySet<string>, touched: ReadonlySet<string>) {
  const next = new Set<string>();
  for (const [id, value] of Object.entries(baseline.values))
    if (touched.has(id) ? deferred.has(id) : value.status === "deferred") next.add(id);
  return next;
}

/**
 * One confirmation per step, bound to the snapshot the user reviewed
 * (CONVERSATION-DRIVEN-CAPTURE §3.7). The three existing phases (information →
 * save → confirm) are unchanged and resumable from the browser envelope; an
 * envelope left by the earlier single-question page is finished as it was.
 */
export function useStepConfirmation(deps: StepConfirmationDeps) {
  const lock = useRef(false);
  const reviewRead = useRef(0);
  useEffect(() => () => { reviewRead.current++; }, [deps.draftId]);
  const [confirming, setConfirming] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const key = (stepId: string) => confirmKey(deps.draftId, stepId);
  const io = (): ConfirmationIo => ({ ...deps, storage: sessionStorage });

  function envelopeState(stepId: string): ConfirmEnvelopeState {
    if (!deps.ready || typeof window === "undefined") return { kind: "none" };
    const raw = sessionStorage.getItem(key(stepId));
    if (!raw) return { kind: "none" };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { kind: "malformed", raw }; }
    return isConfirmStepEnvelope(parsed) ? { kind: "valid", envelope: parsed, raw } : { kind: "malformed", raw };
  }

  async function recoverMalformed(stepId: string) {
    const state = envelopeState(stepId);
    if (state.kind !== "malformed") return;
    deps.setRunning(true);
    deps.setError("");
    try {
      // Retain the unreadable value as evidence, read server state, then release the step.
      sessionStorage.setItem("opc-confirm-step-archive:" + deps.draftId + ":" + stepId, state.raw);
      const result = await deps.refetch();
      if (result.error || !result.data) throw new Error("OPC_UNAVAILABLE");
      sessionStorage.removeItem(key(stepId));
    } catch {
      deps.setError("恢复未完成。原始确认记录已保留在本机，请稍后重试。");
    } finally {
      deps.setRunning(false);
    }
  }

  async function guarded(step: Step, build: () => Promise<ConfirmStepEnvelope | null>) {
    if (lock.current) return;
    lock.current = true;
    setConfirming(true);
    deps.setError("");
    try {
      const request = await build();
      if (!request) return;
      const failure = await deps.run(async () => {
        try { await executeConfirmation(io(), step, request); }
        catch (cause) {
          if (isDefiniteConfirmConflict(cause)) {
            sessionStorage.removeItem(key(step.id));
            await deps.refetch();
          }
          throw cause;
        }
      });
      if (failure) deps.setError(failure instanceof Error && failure.message.includes("OPC_INFORMATION_REQUIRED")
        ? "还有必需信息没有确认或写明暂缓原因，请补充后再确认这一步。"
        : "确认没有完成或内容已变化。你的输入仍保留，请重新核对这一步后再确认。");
      else setReview(old => old?.stepId === step.id ? null : old);
    } catch (cause) {
      if (cause instanceof Error && cause.message === REVIEW_CHANGED) return;
      deps.setError("确认没有完成或内容已变化。你的输入仍保留，请重新核对这一步后再确认。");
    } finally {
      lock.current = false;
      setConfirming(false);
    }
  }

  /** "确认这一步": resume a retained envelope, or open the review of the visible step. */
  function open(stepId: string, info: StepInformation, edits: Record<string, FieldValue> | undefined,
    stepStates: Record<string, { version: number }>) {
    const step = deps.steps.find(item => item.id === stepId);
    if (!step) return;
    const state = envelopeState(stepId);
    if (state.kind === "malformed") {
      deps.setError("上次的确认记录无法读取，结果未知。请先点“重试”保留原始内容，再重新核对这一步。");
      return;
    }
    if (state.kind === "valid") { void guarded(step, async () => state.envelope); return; }
    loadReview(stepId, info, edits, stepStates);
  }

  /** The review of exactly what is shown now. Deferrals follow it, including an unsaved edit that replaced a reason. */
  function newReview(stepId: string, info: StepInformation, edits: Record<string, FieldValue> | undefined,
    stepStates: Record<string, { version: number }>): Review {
    const baseline = visibleStep(info, edits);
    const deferred = new Set(Object.entries(baseline.values).filter(([, value]) => value.status === "deferred").map(([id]) => id));
    return { stepId, baseline, upstream: upstreamVersions(deps.steps, stepId, stepStates), edits: {},
      deferred, touched: new Set(), problems: [], changed: false };
  }

  /** Bind a newly opened dialog to an actual read, never to the cache passed by the card. */
  function loadReview(stepId: string, info: StepInformation, edits: Record<string, FieldValue> | undefined,
    stepStates: Record<string, { version: number }>) {
    if (lock.current) return;
    const request = ++reviewRead.current;
    const initial = newReview(stepId, info, edits, stepStates);
    setReview({ ...initial, loading: true });
    void (async () => {
      try {
        await deps.flush(stepId);
        const current = await readConfirmation(io());
        if (!current.information[stepId] || !current.snapshot.steps[stepId]) throw new Error("OPC_UNAVAILABLE");
        if (reviewRead.current !== request) return;
        const fresh = newReview(stepId, current.information[stepId], deps.pendingEdits(stepId), current.snapshot.steps);
        setReview(old => old ? { ...fresh, edits: old.edits, touched: old.touched,
          deferred: refreshedDeferrals(fresh.baseline, old.deferred, old.touched),
          changed: !sameVisibleStep(initial.baseline, fresh.baseline), loading: false } : old);
      } catch {
        if (reviewRead.current === request) setReview(old => old ? { ...old, loading: false, loadError: true } : old);
      }
    })();
  }

  /**
   * The confirmation card's one click: confirm what the card shows, with the same snapshot and upstream
   * checks as the review. A problem, or content that changed meanwhile, opens the review instead.
   */
  function confirmNow(stepId: string, info: StepInformation, edits: Record<string, FieldValue> | undefined,
    stepStates: Record<string, { version: number }>, settled = true) {
    const step = deps.steps.find(item => item.id === stepId);
    if (!step) return;
    const state = envelopeState(stepId);
    if (state.kind !== "none") { open(stepId, info, edits, stepStates); return; }
    // The tab may have returned before its background query: read before allowing review confirmation.
    if (!settled) { loadReview(stepId, info, edits, stepStates); return; }
    submitReview(newReview(stepId, info, edits, stepStates), info);
  }

  function setDeferred(fieldId: string, deferred: boolean) {
    setReview(old => {
      if (!old) return old;
      const next = new Set(old.deferred);
      if (deferred) next.add(fieldId); else next.delete(fieldId);
      return { ...old, deferred: next, touched: new Set(old.touched).add(fieldId), problems: old.problems.filter(problem => problem.fieldId !== fieldId) };
    });
  }

  /** Submit the review: the server content must still be exactly what the user saw. */
  function submit(info: StepInformation) {
    if (review && !review.loading && !review.loadError) submitReview(review, info);
  }

  function submitReview(review: Review, info: StepInformation) {
    const step = deps.steps.find(item => item.id === review.stepId);
    if (!step) return;
    const reviewed = reviewedStep(review, deps.pendingEdits(step.id));
    const { values, problems } = stepConfirmationValues(info.schema, reviewed, review.deferred, deps.nonAnswers(step.id));
    if (problems.length) { setReview({ ...review, problems, changed: false }); return; }
    void guarded(step, async () => {
      const prepared = await prepareConfirmation(io(), step, info, reviewed, values, review.upstream, deps.steps);
      if ("envelope" in prepared) return prepared.envelope;
      // Something the user did not see arrived: show it and ask for a new review.
      setReview({ ...review, baseline: prepared.changed, upstream: prepared.upstream, edits: {}, problems: [], changed: true,
        deferred: refreshedDeferrals(prepared.changed, review.deferred, review.touched) });
      throw new Error(REVIEW_CHANGED);
    });
  }

  return {
    confirming, review, envelopeState, recoverMalformed, open, confirmNow, setDeferred, submit,
    noteEdit: (fieldId: string, value: FieldValue) =>
      setReview(old => old ? { ...old, edits: { ...old.edits, [fieldId]: value } } : old),
    close: () => { reviewRead.current++; setReview(null); },
  };
}
