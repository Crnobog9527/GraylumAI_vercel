/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/trpc/client";
import { usePaygResume } from "@/lib/use-payg-resume";
import { liveReplyAfter, startLiveReply, type LiveReply } from "./agent-turn-display";
import { readAgentTurn, TEXT_PROTOCOL } from "./mentor-turn";
import { sendStop, stopRequestFor } from "./stop-reply";
import {
  readReportRecord, reportAttachable, reportProgressing, reportRecordKey, reportStartRefusal, startedExecution,
  writeReportRecord, type ReportRecord, type StartRefusal,
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
 * One round's report (REPORT-GEN): start with a retained requestId, stream the same execution,
 * stop, BILL-PAYG pause and "继续", and the saved result from `runtime.reportStatus`.
 * `active` is false until the switch is on and every step is confirmed; nothing is read before.
 */
export function useReportGen(input: { draftId: string; sessionId: string; projectId: string; roundId: string; active: boolean }) {
  const { draftId, sessionId, projectId, roundId, active } = input;
  const key = reportRecordKey(draftId, roundId);
  const utils = trpc.useUtils();
  const [record, setRecord] = useState<ReportRecord | null>(null);
  useEffect(() => setRecord(readReportRecord(localStore(), key)), [key]);
  const save = (next: ReportRecord) => {
    writeReportRecord(localStore(), key, next);
    setRecord(next);
  };
  const start = trpc.runtime.reportStart.useMutation();
  const cancel = trpc.runtime.cancel.useMutation();
  const [live, setLive] = useState<LiveReply | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);
  const executionId = record?.executionId;
  const status = trpc.runtime.reportStatus.useQuery({ executionId: executionId ?? "" }, {
    enabled: active && Boolean(executionId),
    refetchInterval: query => !streaming && reportProgressing(query.state.data) ? POLL_MS : false,
  });
  const payg = usePaygResume(() => status.refetch());

  const stream = async (id: string) => {
    setStreaming(true);
    setLive(startLiveReply(id));
    try {
      const events = await utils.client.runtime.executeStream.mutate({ executionId: id, textProtocol: TEXT_PROTOCOL });
      await readAgentTurn(events, {
        executionId: id,
        onProgress: (execution, event) => setLive(old => liveReplyAfter(old, execution, event)),
        onFinished: () => void utils.credits.getBalance.invalidate(),
      });
    } catch {
      /* A lost stream: the saved status below tells what happened; polling takes over. */
    } finally {
      setStreaming(false);
      await status.refetch();
      setLive(null);
    }
  };

  // A reload or a lost stream: attach to the same execution once. The server replays, never calls twice.
  const attached = useRef(new Set<string>());
  const latestStream = useRef(stream);
  useEffect(() => { latestStream.current = stream; });
  useEffect(() => {
    const id = status.data?.executionId;
    if (!active || streaming || !id || !reportAttachable(status.data) || attached.current.has(id)) return;
    attached.current.add(id);
    void latestStream.current(id);
  }, [active, streaming, status.data]);

  const run = async (fresh: boolean) => {
    if (start.isPending || streaming) return;
    setRefusal(null);
    const requestId = !fresh && record && !record.executionId ? record.requestId : crypto.randomUUID();
    save({ requestId });
    try {
      const id = startedExecution(await start.mutateAsync({ sessionId, projectId, roundId, requestId }));
      if (!id) throw new Error("REPORT_UNAVAILABLE");
      save({ requestId, executionId: id });
      attached.current.add(id);
      await stream(id);
    } catch (cause) {
      // The same identity cannot be reused for this request; the next click forms a new one.
      if (cause instanceof Error && cause.message === "REPORT_REQUEST_CONFLICT") save({ requestId: crypto.randomUUID() });
      setRefusal(reportStartRefusal(cause));
    }
  };

  const stop = async () => {
    if (!live || live.stopped) return;
    const frozen = { ...live, stopped: true, stalled: true };
    setLive(frozen);
    await sendStop(stopRequestFor(frozen), request => cancel.mutateAsync(request));
    await status.refetch();
  };

  return {
    record, status: status.data ?? null, live, streaming, refusal, payg,
    starting: start.isPending,
    /** First start, or a retry of a start whose answer was lost (same request). */
    start: () => void run(false),
    /** A new request after the previous one ended without a report. */
    restart: () => void run(true),
    stop: () => void stop(),
  };
}
