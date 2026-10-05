/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/trpc/client";
import type { LiveReply } from "./agent-turn-display";
import { liveReplyController, type LiveReplyController } from "./live-reply-controller";
import { readAgentTurn, TEXT_PROTOCOL } from "./mentor-turn";
import { executionSettled, RecoveryTimers, type RecoveryHistory, type RecoveryExecution } from "./step-recovery";
import { sendStop, STOP_UNCONFIRMED_NOTICE, stopFollowUpDelay, stopFollowUpTarget, userStopped } from "./stop-reply";

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
 */
export function useLiveReply(draftId: string, history: RecoveryHistory | undefined, onError: (text: string) => void):
  LiveReplyController & { reply: LiveReply | null; phase: string | null; stopAction: { onClick: () => void } | null } {
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
  const followUp = stopFollowUpTarget(history as { executions?: RecoveryExecution[] } | undefined, live.streaming);
  const attempts = useRef(new Map<string, number>());
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!followUp) return;
    const timers = new RecoveryTimers(), attempt = attempts.current.get(followUp) ?? 0;
    let disposed = false;
    timers.schedule(stopFollowUpDelay(attempt), () => {
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
  const canStop = Boolean(reply && !reply.stopped && !["incomplete", "saving"].includes(reply.phase)
    && !(recorded && (executionSettled(history, recorded.executionId) || userStopped(recorded as RecoveryExecution))));
  const stop = async (executionId: string) => {
    const outcome = await sendStop(live.stop(executionId), request => cancel.mutateAsync(request));
    if (outcome === "unconfirmed") onError(STOP_UNCONFIRMED_NOTICE);
    if (outcome) await utils.runtime.view.invalidate();
  };
  return {
    ...live, reply,
    phase: reply ? (reply.stopped ? "stopped" : reply.phase) : null,
    stopAction: canStop && reply ? { onClick: () => void stop(reply.executionId) } : null,
  };
}
