/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useEffect, useRef, useState } from "react";
import { fieldMeta, type CaptureSuggestion, type StepInformation } from "@/components/opc/capture-state";

type ResolveRead = { information: Record<string, StepInformation>; snapshot: { state?: string; steps: Record<string, { version: number }> } };
export type ResolveInput = {
  draftId: string; requestId: string; stepId: string; fieldId: string;
  executionId: string; hash: string; action: "accept" | "ignore"; expectedVersion: number;
};
export type CaptureResolveDeps = {
  draftId: string;
  /** The draft is loaded and still a draft round. */
  active: boolean;
  refetch: () => Promise<{ data?: ResolveRead | null; error?: unknown }>;
  flush: (stepId: string) => Promise<void>;
  resolve: (input: ResolveInput) => Promise<unknown>;
  pending: (input: { draftId: string }) => Promise<{ processed: unknown[] }>;
  setError: (message: string) => void;
};

/** Refusals that prove nothing was written: the update changed or became unreadable, or the step moved on. */
export const RESOLVE_STALE = ["OPC_SUGGESTION_CHANGED", "OPC_INFORMATION_CONFLICT", "OPC_REQUEST_CONFLICT", "OPC_CAPTURE_DENIED"];
export const RESOLVE_STALE_NOTICE = "这条更新已经处理过或刚刚有变化，已刷新为最新内容。请再看一下右侧清单。";
export const RESOLVE_FAILED_NOTICE = "这次没有处理成功，原内容保持不变。请稍后重试。";

/**
 * One adopt/ignore of the update the user saw. Returns the notice to show, or
 * null on success. A refusal that proves nothing was written refreshes the draft.
 */
export async function resolveCaptureUpdate(io: Pick<CaptureResolveDeps, "draftId" | "refetch" | "flush" | "resolve">,
  stepId: string, fieldId: string, suggestion: CaptureSuggestion, action: "accept" | "ignore") {
  try {
    // Save the user's own edits first, so the server version is the one they see.
    await io.flush(stepId);
    const read = await io.refetch();
    if (read.error || !read.data) throw new Error("OPC_UNAVAILABLE");
    const shown = fieldMeta(read.data.information[stepId], fieldId).suggestion;
    if (shown?.executionId !== suggestion.executionId || shown.hash !== suggestion.hash) return RESOLVE_STALE_NOTICE;
    await io.resolve({ draftId: io.draftId, requestId: crypto.randomUUID(), stepId, fieldId,
      executionId: suggestion.executionId, hash: suggestion.hash, action,
      expectedVersion: read.data.snapshot.steps[stepId]!.version });
    await io.refetch();
    return null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    // A lost reply is retried by a new click: the server then reports the update as already gone.
    if (!RESOLVE_STALE.some(code => message.includes(code))) return RESOLVE_FAILED_NOTICE;
    await io.refetch().catch(() => undefined);
    return RESOLVE_STALE_NOTICE;
  }
}

/**
 * Adopt or ignore one "根据对话整理的更新" through `opc.captureResolve`, bound to the
 * exact execution and hash the user saw. Field protection stays on the server:
 * the page never writes a suggested value through autosave. Opening the page
 * also applies any finished conversation turn that was not captured yet
 * (`opc.capturePending`, no model call and no charge).
 */
export function useCaptureResolve(deps: CaptureResolveDeps) {
  const [resolving, setResolving] = useState<string | null>(null);
  const caught = useRef<string | null>(null);
  const { active, draftId } = deps;
  const latest = useRef(deps);
  useEffect(() => { latest.current = deps; });
  useEffect(() => {
    if (!active || caught.current === draftId) return;
    caught.current = draftId;
    // Best effort: the next mentor admission applies the same pending turns again.
    void latest.current.pending({ draftId }).then(result => {
      if (result.processed.length) return latest.current.refetch();
    }).catch(() => undefined);
  }, [active, draftId]);

  async function resolve(stepId: string, fieldId: string, suggestion: CaptureSuggestion, action: "accept" | "ignore") {
    if (resolving) return;
    setResolving(stepId + ":" + fieldId);
    deps.setError("");
    try {
      const notice = await resolveCaptureUpdate(deps, stepId, fieldId, suggestion, action);
      if (notice) deps.setError(notice);
    } finally {
      setResolving(null);
    }
  }
  return { resolving, resolve };
}
