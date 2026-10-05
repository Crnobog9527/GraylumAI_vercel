/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/trpc/client";
import type { LiveReply } from "./agent-turn-display";
import { liveReplyController, type LiveReplyController } from "./live-reply-controller";
import { readAgentTurn, TEXT_PROTOCOL } from "./mentor-turn";
import { executionSettled, RecoveryTimers, type RecoveryHistory, type RecoveryExecution } from "./step-recovery";
import {
  rememberStop, sendStop, stopFollowUpDelay, stopFollowUpTarget, stopAvailable, stoppedHere,
} from "./stop-reply";

function tabStorage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The page's live mentor reply (see live-reply-controller.ts) bound to React
 * state and page lifecycle events, with 停止 (stop-reply.ts). `phase` is the
 * live notice to show and `stopAction` the 停止 button, when one applies.
 * A stopped turn that this page no longer streams is re-read a bounded number
 * of times (STOP_FOLLOW_UP_DELAYS_MS), never polled without end.
 */
export function useLiveReply(draftId: string, history: RecoveryHistory | undefined):
  LiveReplyController & {
    reply: LiveReply | null; phase: string | null; stopAction: { onClick: () => void } | null;
    /** This tab's own knowledge of its stop of `executionId` (MentorReplySource.stopLocal). */
    stopLocal: (executionId: string) => "unconfirmed" | "stopped" | undefined;
  } {
  const [reply, setReply] = useState<LiveReply | null>(null);
  const live = useMemo(() => liveReplyController({ draftId, storage: tabStorage, show: setReply }), [draftId]);
  const utils = trpc.useUtils();
  const cancel = trpc.runtime.cancel.useMutation();
  useEffect(() => {
    live.restore();
    const hide = () => live.pageHide();
    const reshow = (event: PageTransitionEvent) => live.pageShow(event.persisted);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", reshow);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", reshow);
    };
  }, [live]);
  // A waiting or stopped copy whose execution history already shows finished gives way to the stored reply.
  const waitingId = reply && (reply.phase === "waiting" || reply.stopped) ? reply.executionId : null;
  const settled = Boolean(waitingId && executionSettled(history, waitingId));
  useEffect(() => {
    if (settled && waitingId) live.settle(waitingId);
  }, [live, settled, waitingId]);

  // A stopped turn that this page no longer streams (a reload, a lost connection) is re-read with
  // growing delays until history holds its result: the server rebuilds it from the saved receipt.
  // The reads are bounded; after the last one the turn says its stop is not confirmed yet.
  const followUp = stopFollowUpTarget(history as { executions?: RecoveryExecution[] } | undefined, live.streaming);
  const attempts = useRef(new Map<string, number>());
  const [round, setRound] = useState(0);
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  useEffect(() => {
    if (!followUp) return;
    const timers = new RecoveryTimers(), attempt = attempts.current.get(followUp) ?? 0;
    const delay = stopFollowUpDelay(attempt);
    if (delay === null) {
      setUnconfirmed(followUp);
      return;
    }
    let disposed = false;
    timers.schedule(delay, () => {
      attempts.current.set(followUp, attempt + 1);
      void (async () => {
        try {
          const events = await utils.client.runtime.executeStream.mutate({ executionId: followUp, textProtocol: TEXT_PROTOCOL });
          await readAgentTurn(events, { executionId: followUp, onProgress: () => undefined });
        } catch {
          /* Still saving or unreachable: the next attempt reads it again. */
        }
        await utils.runtime.view.invalidate();
        // One read at a time; the next waits for its own delay.
        if (!disposed) setRound(value => value + 1);
      })();
    });
    return () => {
      disposed = true;
      timers.dispose();
    };
  }, [followUp, round, utils]);

  const recorded = reply ? history?.executions?.find(execution => execution.executionId === reply.executionId) : undefined;
  const canStop = stopAvailable(reply, recorded as RecoveryExecution | undefined,
    Boolean(recorded && executionSettled(history, recorded.executionId)));
  const stop = async (executionId: string) => {
    const request = live.stop(executionId);
    if (request) rememberStop(tabStorage(), draftId, executionId);
    const outcome = await sendStop(request, next => cancel.mutateAsync(next));
    // A failed request leaves the reply frozen: its own live notice says the stop is unconfirmed (one notice,
    // gone with the live reply once history holds the result).
    if (outcome === "unconfirmed") setUnconfirmed(executionId);
    if (outcome) await utils.runtime.view.invalidate();
  };
  return {
    ...live, reply,
    phase: reply ? (reply.stopped ? (unconfirmed === reply.executionId ? "stop_unconfirmed" : "stopped") : reply.phase) : null,
    stopLocal: (executionId: string) => unconfirmed === executionId ? "unconfirmed"
      : stoppedHere(tabStorage(), draftId).includes(executionId) ? "stopped" : undefined,
    stopAction: canStop && reply ? { onClick: () => void stop(reply.executionId) } : null,
  };
}
