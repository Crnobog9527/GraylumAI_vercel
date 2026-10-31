/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
import { runTurn } from "@/lib/turn-stream";
import { mentorTurnEvents } from "./mentor-turn-path";
import { reportProgressing, type ReportStatus, type ServerReport } from "./report-gen";
import { turnReportStop, type TurnStopAnswer } from "./turn-report-stop";

/*
 * CORE-PATH-V2 V2-10: the report on the turn path. A report turn is known by its request id: that is the id report_document takes, so the
 * document panel, saving and finalizing stay as they are. The turn id is what a stop names. The turn runs inside the request that
 * started it: there is nothing to attach to after a reload, the saved status is re-read until the report closes.
 */
const READ_MS = 3000;
const fetcher: typeof fetch = (...args) => globalThis.fetch(...args);
export type TurnReport = { turnId: number; requestId: string; state: string; closeKind: string | null; delivered: boolean;
  chargedCredits: number | null; settlement: string | null; fixedCredits: number | null; body: string | null };

/** The report as the page reads a status: open states, then how it closed, and whether its fixed price was charged. */
export function turnReportStatus(report: TurnReport): ReportStatus {
  const closed = report.state === "closed", stopped = report.closeKind === "stopped";
  const state = !closed ? ({ paused: "waiting_credits", stopping: "stopping" }[report.state] ?? "running")
    : report.delivered ? "completed" : "cancelled";
  const fee = report.fixedCredits === null ? null : { credits: report.fixedCredits, chargedCredits: report.chargedCredits,
    state: report.settlement !== "done" ? "held" as const : report.chargedCredits ? "charged" as const : "refunded" as const };
  return { executionId: report.requestId, state, body: report.body, candidate: report.delivered, fee,
    completeness: report.delivered ? "complete" : stopped ? "stopped" : null };
}

export function useTurnReport(on: boolean, sessionId: string, roundId: string) {
  const [report, setReport] = useState<TurnReport | null | undefined>(undefined), [failed, setFailed] = useState(false);
  // A report already written stays readable whatever the switch says now (a rollback must not hide a paid report); `on` only
  // decides whether a new one starts here.
  const refetch = useCallback(async () => {
    try {
      const query = `sessionId=${encodeURIComponent(sessionId)}&roundId=${encodeURIComponent(roundId)}`;
      const response = await fetcher(`/api/turn/report?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("TURN_REPORT_READ_FAILED");
      const next = (await response.json() as { report: TurnReport | null }).report;
      setReport(next); setFailed(false);
      return { data: next ? turnReportStatus(next) : null };
    } catch { setFailed(true); return { data: null }; }
  }, [sessionId, roundId]);
  useEffect(() => { void refetch(); }, [refetch]);
  const status = report ? turnReportStatus(report) : null, turning = useRef(false);
  const progressing = reportProgressing(status);
  useEffect(() => {
    if (!progressing) return;
    const timer = setInterval(() => { if (!turning.current) void refetch(); }, READ_MS);
    return () => clearInterval(timer);
  }, [progressing, refetch]);
  const server: ServerReport = report !== undefined ? { kind: "known", executionId: report?.requestId ?? null }
    : failed ? { kind: "failed" } : { kind: "pending" };

  const abort = useRef<AbortController | null>(null), turnId = useRef<number | null>(null);
  /** The report's events; its stream stays this page's until a recorded stop drops it. */
  async function* events(body: unknown, onOpened: () => void): AsyncGenerator<AgentTurnEvent> {
    const controller = abort.current = new AbortController();
    turning.current = true;
    try {
      for await (const event of mentorTurnEvents(body, (request, onEvent) => runTurn(request, onEvent, { fetch: fetcher, signal: controller.signal }))) {
        if (event.type === "admitted") { turnId.current = Number(event.executionId.slice(5)); onOpened(); }
        else yield event;
      }
    } finally { turning.current = false; }
  }
  const stop = async (request: { stopAt?: number; confirmed?: boolean }): Promise<TurnStopAnswer> => {
    const id = turnId.current ?? report?.turnId;
    if (!id) throw new Error("TURN_STOP_FAILED");
    return turnReportStop({ fetch: fetcher, dropStream: () => abort.current?.abort() })(
      { turnId: id, stopAt: request.stopAt ?? 0, ...(request.confirmed ? { confirmed: true } : {}) });
  };
  return { on, server, status, refetch, events, stop };
}
