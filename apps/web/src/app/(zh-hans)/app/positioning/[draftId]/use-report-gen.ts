/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
import { RUNTIME_CHOICES_STALE_MS } from "@/lib/runtime-choices";
import { trpc } from "@/trpc/client";
import { TurnRefused } from "./mentor-turn-path";
import { useTurnReport } from "./use-turn-report";
import { usePaygResume } from "@/lib/use-payg-resume";
import { liveReplyAfter, startLiveReply, type LiveReply } from "./agent-turn-display";
import { readAgentTurn, TEXT_PROTOCOL } from "./mentor-turn";
import { finishReportStop, reportStopBufferAfter, reportStopController, type ReportStopPhase } from "./report-stop";
import { RecoveryTimers } from "./step-recovery";
import {
  attachRetryDelay, generationOffer, needsReattach, newerRead, nextRequestId, readReportRecord, reportAttachable, reportProgressing, reportRecordKey,
  reportResultRefusal, reportStartRefusal, shownExecution, startedExecution, writeReportRecord,
  type FreshRead, type ReportPin, type ReportRecord, type ServerReport, type StartRefusal,
} from "./report-gen";

function localStore() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Re-read interval while the server is still writing or settling a report this page does not stream. */
const POLL_MS = 5000;

/**
 * One round's report (REPORT-GEN): find it on the server, start with a retained requestId, stream
 * the same execution, stop, BILL-PAYG pause and "继续", and the saved result from `reportStatus`.
 * Reading a saved report never depends on the switch or membership; `canGenerate` (switch on and
 * every step confirmed) only allows a new paid start.
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
  // A report written before the switch stays readable: the old reads answer until this round has a turn report.
  const latest = trpc.runtime.reportLatest.useQuery({ sessionId, projectId, roundId }, { retry: 1, enabled: !turn.status });
  const server: ServerReport = turn.status ? turn.server : latest.isSuccess ? { kind: "known", executionId: latest.data.executionId }
    : latest.isError ? { kind: "failed" } : { kind: "pending" };
  // The execution this page started, until the server read names it.
  const [pinned, setPinned] = useState<ReportPin | null>(null);
  // Explicit reads after a start or a refusal, ordered against the pin by generation (report-gen.ts).
  const generation = useRef(0);
  const [fresh, setFresh] = useState<FreshRead | null>(null);
  const readLatest = async () => {
    if ((await turn.refetch()).data) return;
    const own = ++generation.current;
    try {
      const data = await utils.client.runtime.reportLatest.query({ sessionId, projectId, roundId });
      setFresh(current => newerRead(current, { executionId: data.executionId, generation: own }));
      if (own === generation.current) utils.runtime.reportLatest.setData({ sessionId, projectId, roundId }, data);
    } catch {
      /* The page's own query and the next read take over. */
    }
  };
  const executionId = shownExecution(pinned, server, record, fresh);
  const start = trpc.runtime.reportStart.useMutation();
  const cancel = trpc.runtime.cancel.useMutation();
  const [live, setLive] = useState<LiveReply | null>(null);
  const stopBuffer = useRef<LiveReply | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);
  const status = trpc.runtime.reportStatus.useQuery({ executionId: executionId ?? "" }, {
    enabled: Boolean(executionId) && !turn.status,
    refetchInterval: query => !streaming && reportProgressing(query.state.data) ? POLL_MS : false,
  });
  const shown = turn.status ?? (status.data && status.data.executionId === executionId ? status.data : null);
  const reread = () => turn.status || streaming ? turn.refetch() : status.refetch();
  // The status read settles the fixed price (0295: charged or refunded): the cached balance is stale until it is read again.
  const settledFee = shown?.fee && shown.fee.state !== "held" ? shown.fee.state : null;
  useEffect(() => { if (settledFee) void utils.credits.getBalance.invalidate(); }, [settledFee, executionId, utils]);
  const refuse = (result: unknown) => {
    const refusal = reportResultRefusal(result);
    if (refusal) setRefusal(refusal);
  };
  const payg = usePaygResume(reread, refuse);

  // A reload or a lost stream: attach to the same execution. The server replays, never calls twice.
  const attached = useRef(new Set<string>());
  const attempts = useRef(new Map<string, number>());
  const [retryRound, setRetryRound] = useState(0);
  const timers = useRef<RecoveryTimers | null>(null);
  useEffect(() => {
    const own = new RecoveryTimers();
    timers.current = own;
    return () => own.dispose();
  }, []);
  /** The stream could not be opened: allow a bounded re-attach of the same execution. */
  const retryAttach = (id: string) => {
    const attempt = attempts.current.get(id) ?? 0, delay = attachRetryDelay(attempt);
    if (delay === null) return;
    attempts.current.set(id, attempt + 1);
    timers.current?.schedule(delay, () => {
      attached.current.delete(id);
      setRetryRound(value => value + 1);
    });
  };

  // The execution this page attached to without starting it (a reload, another tab): the server streams no text
  // already written, so the dialog says the report is still being written in the background.
  const [reopened, setReopened] = useState<string | null>(null);
  const stream = async (id: string, turnBody?: unknown) => {
    setStreaming(true);
    setLive(startLiveReply(id));
    let events: AsyncIterable<AgentTurnEvent> | null = null;
    try {
      // Once the turn is open a new start needs a new request id; until then the same one replays an unconfirmed start.
      events = turnBody ? turn.events(turnBody, () => save({ requestId: id, executionId: id }))
        : await utils.client.runtime.executeStream.mutate({ executionId: id, textProtocol: TEXT_PROTOCOL });
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
      // Still unfinished on the server (an ambiguous failure): attach to the same execution again.
      if (needsReattach(result)) retryAttach(id);
    } catch (cause) {
      if (cause instanceof TurnRefused) setRefusal(reportStartRefusal(new Error(cause.code)));
      // Never opened: try the same execution again later. A lost open stream: the saved status tells.
      if (!events) retryAttach(id);
    } finally {
      setStreaming(false);
      await (turnBody ? turn.refetch() : reread());
      setLive(null);
    }
  };
  const latestStream = useRef(stream);
  useEffect(() => { latestStream.current = stream; });
  useEffect(() => {
    const id = shown?.executionId;
    if (turn.status || streaming || !id || !reportAttachable(shown) || attached.current.has(id)) return;
    attached.current.add(id);
    setReopened(id);
    void latestStream.current(id);
  }, [streaming, shown, retryRound, turn.status]);

  const working = start.isPending || streaming;
  const offer = generationOffer({ canGenerate, working, server, executionId, status: shown });
  const run = async (kind: "start" | "restart") => {
    // No price on the button, no paid start: the request must carry the price the user was shown.
    if (working || offer !== kind || typeof price !== "number") return;
    setRefusal(null);
    // A start or 重新生成 whose answer never came resends the same request until the server answers.
    const requestId = nextRequestId(record, () => crypto.randomUUID());
    save({ requestId });
    if (turn.on) {
      setPinned({ executionId: requestId, generation: ++generation.current });
      setReopened(null);
      await stream(requestId, { kind: "report", sessionId, requestId, moduleId, projectId, roundId, acceptedCredits: price });
      return;
    }
    try {
      const id = startedExecution(await start.mutateAsync({ sessionId, projectId, roundId, requestId,
        acceptedCredits: price }));
      if (!id) throw new Error("REPORT_UNAVAILABLE");
      save({ requestId, executionId: id });
      setPinned({ executionId: id, generation: ++generation.current });
      setReopened(null);
      void readLatest();
      attached.current.add(id);
      await stream(id);
    } catch (cause) {
      // The same identity cannot be reused for this request; the next click forms a new one.
      if (cause instanceof Error && cause.message === "REPORT_REQUEST_CONFLICT") save({ requestId: crypto.randomUUID() });
      setRefusal(reportStartRefusal(cause));
      void readLatest();
    }
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
  const cancelReport = turn.status || (turn.on && streaming) ? (request: { stopAt?: number; confirmed?: boolean }) => turn.stop(request) : cancel.mutateAsync;
  const latestStop = useRef({ cancel: cancelReport as (request: never) => Promise<{ state?: string } | undefined>, refetch: reread });
  latestStop.current = { cancel: cancelReport as never, refetch: reread };
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
  const stop = async () => {
    if (!live || live.stopped || (stopper.executionId() === live.executionId && stopper.phase() === "sending")) return;
    stopBuffer.current = live;
    setLive({ ...live, stopped: true, stalled: true });
    await stopper.stop(live);
    finishStop(live.executionId);
  };
  const retryStop = async () => {
    const id = stopper.executionId();
    if (!id) return;
    await stopper.retry();
    finishStop(id);
  };

  return {
    executionId, status: shown, live, streaming, refusal, payg, offer,
    /** This page reattached to the shown execution instead of starting it. */
    reopened: reopened !== null && reopened === executionId,
    starting: start.isPending,
    start: () => void run("start"),
    restart: () => void run("restart"),
    stop: () => void stop(),
    stopConfirmation,
    confirmStop: () => answerStop(true),
    cancelStop: () => answerStop(false),
    /** The stop request was not confirmed: 停止 resends the same request. */
    stopUnconfirmed: stopPhase === "unconfirmed" && stopper.executionId() === executionId,
    retryStop: () => void retryStop(),
  };
}
