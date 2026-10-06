/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useRef, useState } from "react";
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
 * Before the first phase, the server content must still be exactly what the user
 * reviewed (their own edits included). Anything else stops with the fresh content.
 */
export async function prepareConfirmation(io: ConfirmationIo, step: Step, info: StepInformation,
  reviewed: VisibleStep, values: Record<string, FieldValue>): Promise<{ changed: VisibleStep } | { envelope: ConfirmStepEnvelope }> {
  await io.flush(step.id);
  const current = await readConfirmation(io);
  const now = visibleStep(current.information[step.id]);
  if (io.pendingEdits(step.id) || !sameVisibleStep(reviewed, now)) return { changed: now };
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

/** `touched`: deferrals the user switched in this dialog; every other one follows the reviewed content. */
type Review = { stepId: string; baseline: VisibleStep; deferred: Set<string>; touched: Set<string>; problems: ReviewProblem[]; changed: boolean };

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
  function open(stepId: string, info: StepInformation, edits?: Record<string, FieldValue>) {
    const step = deps.steps.find(item => item.id === stepId);
    if (!step) return;
    const state = envelopeState(stepId);
    if (state.kind === "malformed") {
      deps.setError("上次的确认记录无法读取，结果未知。请先点“重试”保留原始内容，再重新核对这一步。");
      return;
    }
    if (state.kind === "valid") { void guarded(step, async () => state.envelope); return; }
    const deferred = new Set((info.schema ?? []).filter(field => info.values?.[field.id]?.status === "deferred").map(field => field.id));
    setReview({ stepId, baseline: visibleStep(info, edits), deferred, touched: new Set(), problems: [], changed: false });
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
    if (!review) return;
    const step = deps.steps.find(item => item.id === review.stepId);
    if (!step) return;
    const reviewed = withEdits(review.baseline, deps.pendingEdits(step.id));
    const { values, problems } = stepConfirmationValues(info.schema, reviewed, review.deferred, deps.nonAnswers(step.id));
    if (problems.length) { setReview({ ...review, problems, changed: false }); return; }
    void guarded(step, async () => {
      const prepared = await prepareConfirmation(io(), step, info, reviewed, values);
      if ("envelope" in prepared) return prepared.envelope;
      // Something the user did not see arrived: show it and ask for a new review.
      setReview({ ...review, baseline: prepared.changed, problems: [], changed: true,
        deferred: refreshedDeferrals(prepared.changed, review.deferred, review.touched) });
      throw new Error(REVIEW_CHANGED);
    });
  }

  return {
    confirming, review, envelopeState, recoverMalformed, open, setDeferred, submit,
    close: () => setReview(null),
  };
}
