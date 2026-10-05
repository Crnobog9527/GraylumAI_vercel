/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/trpc/client";
import { usePaygResume } from "@/lib/use-payg-resume";
import { liveReplyAfter, startLiveReply, type LiveReply } from "./agent-turn-display";
import { readAgentTurn, TEXT_PROTOCOL } from "./mentor-turn";
import { reportStopController, type ReportStopPhase } from "./report-stop";
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
export function useReportGen(input: { draftId: string; sessionId: string; projectId: string; roundId: string; canGenerate: boolean }) {
  const { draftId, sessionId, projectId, roundId, canGenerate } = input;
  const key = reportRecordKey(draftId, roundId);
  const utils = trpc.useUtils();
  const [record, setRecord] = useState<ReportRecord | null>(null);
  useEffect(() => setRecord(readReportRecord(localStore(), key)), [key]);
  const save = (next: ReportRecord) => {
    writeReportRecord(localStore(), key, next);
    setRecord(next);
  };
  const latest = trpc.runtime.reportLatest.useQuery({ sessionId, projectId, roundId }, { retry: 1 });
  const server: ServerReport = latest.isSuccess ? { kind: "known", executionId: latest.data.executionId }
    : latest.isError ? { kind: "failed" } : { kind: "pending" };
  // The execution this page started, until the server read names it.
  const [pinned, setPinned] = useState<ReportPin | null>(null);
  // Explicit reads after a start or a refusal, ordered against the pin by generation (report-gen.ts).
  const generation = useRef(0);
  const [fresh, setFresh] = useState<FreshRead | null>(null);
  const readLatest = async () => {
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
  const [streaming, setStreaming] = useState(false);
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);
  const status = trpc.runtime.reportStatus.useQuery({ executionId: executionId ?? "" }, {
    enabled: Boolean(executionId),
    refetchInterval: query => !streaming && reportProgressing(query.state.data) ? POLL_MS : false,
  });
  const shown = status.data && status.data.executionId === executionId ? status.data : null;
  const refuse = (result: unknown) => {
    const refusal = reportResultRefusal(result);
    if (refusal) setRefusal(refusal);
  };
  const payg = usePaygResume(() => status.refetch(), refuse);

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

  const stream = async (id: string) => {
    setStreaming(true);
    setLive(startLiveReply(id));
    let events: Awaited<ReturnType<typeof utils.client.runtime.executeStream.mutate>> | null = null;
    try {
      events = await utils.client.runtime.executeStream.mutate({ executionId: id, textProtocol: TEXT_PROTOCOL });
      const { result } = await readAgentTurn(events, {
        executionId: id,
        onProgress: (execution, event) => setLive(old => liveReplyAfter(old, execution, event)),
        onFinished: () => void utils.credits.getBalance.invalidate(),
      });
      refuse(result);
      // Still unfinished on the server (an ambiguous failure): attach to the same execution again.
      if (needsReattach(result)) retryAttach(id);
    } catch {
      // Never opened: try the same execution again later. A lost open stream: the saved status tells.
      if (!events) retryAttach(id);
    } finally {
      setStreaming(false);
      await status.refetch();
      setLive(null);
    }
  };
  const latestStream = useRef(stream);
  useEffect(() => { latestStream.current = stream; });
  useEffect(() => {
    const id = shown?.executionId;
    if (streaming || !id || !reportAttachable(shown) || attached.current.has(id)) return;
    attached.current.add(id);
    void latestStream.current(id);
  }, [streaming, shown, retryRound]);

  const working = start.isPending || streaming;
  const offer = generationOffer({ canGenerate, working, server, executionId, status: shown });
  const run = async (kind: "start" | "restart") => {
    if (working || offer !== kind) return;
    setRefusal(null);
    // A start or 重新生成 whose answer never came resends the same request until the server answers.
    const requestId = nextRequestId(record, () => crypto.randomUUID());
    save({ requestId });
    try {
      const id = startedExecution(await start.mutateAsync({ sessionId, projectId, roundId, requestId }));
      if (!id) throw new Error("REPORT_UNAVAILABLE");
      save({ requestId, executionId: id });
      setPinned({ executionId: id, generation: ++generation.current });
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
  const latestStop = useRef({ cancel: cancel.mutateAsync, refetch: status.refetch });
  latestStop.current = { cancel: cancel.mutateAsync, refetch: status.refetch };
  const stopper = useMemo(() => reportStopController({
    cancel: request => latestStop.current.cancel(request),
    reread: async () => (await latestStop.current.refetch()).data?.state ?? null,
    schedule: (delay, callback) => timers.current?.schedule(delay, callback),
    onChange: setStopPhase,
  }), []);
  const stop = async () => {
    if (!live || live.stopped) return;
    const frozen = { ...live, stopped: true, stalled: true };
    setLive(frozen);
    await stopper.stop(frozen);
  };

  return {
    executionId, status: shown, live, streaming, refusal, payg, offer,
    starting: start.isPending,
    start: () => void run("start"),
    restart: () => void run("restart"),
    stop: () => void stop(),
    /** The stop request was not confirmed: 停止 resends the same request. */
    stopUnconfirmed: stopPhase === "unconfirmed" && stopper.executionId() === executionId,
    retryStop: () => void stopper.retry(),
  };
}
