/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
import { RUNTIME_CHOICES_STALE_MS } from "@/lib/runtime-choices";
import { trpc } from "@/trpc/client";
import { TurnRefused } from "./mentor-turn-path";
import { useTurnReport } from "./use-turn-report";
import { usePaygResume } from "@/lib/use-payg-resume";
import { liveReplyAfter, startLiveReply, type LiveReply } from "./agent-turn-display";
import { readAgentTurn } from "./mentor-turn";
import { finishReportStop, reportStopBufferAfter, reportStopController, type ReportStopPhase } from "./report-stop";
import { RecoveryTimers } from "./step-recovery";
import {
  generationOffer, nextRequestId, readReportRecord, reportRecordKey, reportResultRefusal, reportStartRefusal, shownExecution,
  writeReportRecord, type ReportPin, type ReportRecord, type StartRefusal,
} from "./report-gen";

function localStore() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * One round's report (REPORT-GEN) on the turn path (CORE-PATH-V2 V2-12 B6): find it on the server (`/api/turn/report`), start
 * with a retained requestId, stream the turn, stop, BILL-PAYG pause and "继续". A report's handle is its request id.
 * Reading a saved report never depends on the switch or membership; `canGenerate` (switch on and
 * every step confirmed) only allows a new paid start, and a new start needs the turn switch.
 */
export function useReportGen(input: { draftId: string; sessionId: string; projectId: string; roundId: string; moduleId?: string | null; canGenerate: boolean;
  /** The fixed price the button shows (0295): sent with the start, which is refused if the price changed meanwhile. */
  price?: number | null }) {
  const { draftId, sessionId, projectId, roundId, moduleId, canGenerate, price } = input;
  const key = reportRecordKey(draftId, roundId);
  const utils = trpc.useUtils();
  const [record, setRecord] = useState<ReportRecord | null>(null);
  useEffect(() => setRecord(readReportRecord(localStore(), key)), [key]);
  const save = (next: ReportRecord) => {
    writeReportRecord(localStore(), key, next);
    setRecord(next);
  };
  const choices = trpc.runtime.choices.useQuery({ sessionId }, { staleTime: RUNTIME_CHOICES_STALE_MS });
  const turn = useTurnReport(Boolean(choices.data?.corePathV2), sessionId, roundId);
  const server = turn.server;
  // The report this page started, until the server read names it.
  const [pinned, setPinned] = useState<ReportPin | null>(null);
  const executionId = shownExecution(pinned, server, record);
  const [live, setLive] = useState<LiveReply | null>(null);
  const stopBuffer = useRef<LiveReply | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);
  const shown = turn.status;
  const reread = turn.refetch;
  // The status read settles the fixed price (0295: charged or refunded): the cached balance is stale until it is read again.
  const settledFee = shown?.fee && shown.fee.state !== "held" ? shown.fee.state : null;
  useEffect(() => { if (settledFee) void utils.credits.getBalance.invalidate(); }, [settledFee, executionId, utils]);
  const refuse = (result: unknown) => {
    const refusal = reportResultRefusal(result);
    if (refusal) setRefusal(refusal);
  };
  const payg = usePaygResume(reread, refuse);

  const timers = useRef<RecoveryTimers | null>(null);
  useEffect(() => {
    const own = new RecoveryTimers();
    timers.current = own;
    return () => own.dispose();
  }, []);

  // The turn runs inside the request that started it: a reload or a lost stream has nothing to attach to, the saved report is
  // re-read until it closes (use-turn-report.ts).
  const stream = async (id: string, body: unknown) => {
    setStreaming(true);
    setLive(startLiveReply(id));
    try {
      // The report is shown once the server opened it: a start refused before that creates nothing to show or to retry against.
      const events = turn.events(body, () => { save({ requestId: id, executionId: id }); setPinned({ executionId: id }); });
      const { result } = await readAgentTurn(events, {
        executionId: id,
        onProgress: (execution, event) => {
          if (stopBuffer.current?.executionId === execution)
            stopBuffer.current = liveReplyAfter(stopBuffer.current, execution, event);
          setLive(old => liveReplyAfter(old, execution, event));
        },
        onFinished: () => void utils.credits.getBalance.invalidate(),
      });
      refuse(result);
    } catch (cause) {
      if (cause instanceof TurnRefused) setRefusal(reportStartRefusal(new Error(cause.code)));
    } finally {
      setStreaming(false);
      await turn.refetch();
      setLive(null);
    }
  };

  const working = streaming;
  const offer = generationOffer({ canGenerate: canGenerate && turn.on, working, server, executionId, status: shown });
  const run = async (kind: "start" | "restart") => {
    // No price on the button, no paid start: the request must carry the price the user was shown.
    // A paid start before the switch has answered would have no path to go to.
    if (working || offer !== kind || typeof price !== "number" || !(choices.isSuccess || choices.isError)) return;
    setRefusal(null);
    // A start or 重新生成 whose answer never came resends the same request until the server answers.
    const requestId = nextRequestId(record, () => crypto.randomUUID());
    save({ requestId });
    await stream(requestId, { kind: "report", sessionId, requestId, moduleId, projectId, roundId, acceptedCredits: price });
  };

  // 停止: one fixed request per page, resent on an unconfirmed answer, then a bounded status follow-up.
  const [stopPhase, setStopPhase] = useState<ReportStopPhase>("idle");
  const [stopConfirmation, setStopConfirmation] = useState(false);
  const stopAnswer = useRef<((confirmed: boolean) => void) | null>(null);
  const answerStop = (confirmed: boolean) => {
    const answer = stopAnswer.current;
    stopAnswer.current = null;
    setStopConfirmation(false);
    answer?.(confirmed);
  };
  useEffect(() => () => { stopAnswer.current?.(false); stopAnswer.current = null; }, []);
  const latestStop = useRef({ cancel: turn.stop as (request: never) => Promise<{ state?: string } | undefined>, refetch: reread });
  latestStop.current = { cancel: turn.stop as never, refetch: reread };
  const stopper = useMemo(() => reportStopController({
    cancel: async request => {
      const result = await latestStop.current.cancel(request as never);
      if (result?.state !== "confirmation_required") return result;
      const confirmed = await new Promise<boolean>(resolve => {
        stopAnswer.current = resolve;
        setStopConfirmation(true);
      });
      if (!confirmed) return { state: "confirmation_declined" };
      return latestStop.current.cancel({ ...request, confirmed: true } as never);
    },
    reread: async () => (await latestStop.current.refetch()).data?.state ?? null,
    schedule: (delay, callback) => timers.current?.schedule(delay, callback),
    onChange: setStopPhase,
  }), []);
  useEffect(() => {
    if (stopPhase === "settled" && stopBuffer.current?.executionId === stopper.executionId()) stopBuffer.current = null;
  }, [stopPhase, stopper]);
  const finishStop = (id: string) => {
    const buffered = stopBuffer.current;
    if (buffered?.executionId !== id) return;
    const phase = stopper.phase();
    const next = reportStopBufferAfter(buffered, phase);
    stopBuffer.current = next.keep;
    const restored = next.restore;
    if (restored) setLive(current => finishReportStop(current, restored, phase));
  };
  // A report still being written that this page did not start (a reload, another device) has no stream here, but it can be stopped:
  // the stop names its turn, and what the page showed is what the stopped report keeps.
  const stopsWithoutStream = Boolean(turn.status && !live && !streaming && shown?.state === "running");
  const stop = async () => {
    const reply = live ?? (stopsWithoutStream && shown ? { ...startLiveReply(shown.executionId), text: shown.body ?? "" } : null);
    if (!reply || reply.stopped || (stopper.executionId() === reply.executionId && stopper.phase() === "sending")) return;
    stopBuffer.current = reply;
    setLive({ ...reply, stopped: true, stalled: true });
    await stopper.stop(reply);
    finishStop(reply.executionId);
  };
  const retryStop = async () => {
    const id = stopper.executionId();
    if (!id) return;
    await stopper.retry();
    finishStop(id);
  };

  return {
    executionId, status: shown, live, streaming, refusal, payg, offer,
    start: () => void run("start"),
    restart: () => void run("restart"),
    stop: () => void stop(),
    /** A report written on, with no stream on this page, can still be stopped. */
    canStopWithoutStream: stopsWithoutStream,
    stopConfirmation,
    confirmStop: () => answerStop(true),
    cancelStop: () => answerStop(false),
    /** The stop request was not confirmed: 停止 resends the same request. */
    stopUnconfirmed: stopPhase === "unconfirmed" && stopper.executionId() === executionId,
    retryStop: () => void retryStop(),
  };
}
