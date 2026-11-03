/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
import type { LiveReply } from "./agent-turn-display";
import { useReopenGrace } from "./mentor-turn-steps";
import { liveReplyController, type LiveReplyController } from "./live-reply-controller";
import { executionSettled, type RecoveryHistory } from "./step-recovery";
import { stoppedHere } from "./stop-reply";

export { useMentorTurnPath } from "./use-mentor-turn-path";

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
export function useLiveReply(draftId: string, history: RecoveryHistory | undefined,
  observe?: (executionId: string, event: AgentTurnEvent) => void):
  LiveReplyController & {
    reply: LiveReply | null; phase: string | null; reopenGraceOver: boolean; stopAction: { onClick: () => void } | null;
    /** This tab's own knowledge of its stop of `executionId` (MentorReplySource.stopLocal). */
    stopLocal: (executionId: string) => "unconfirmed" | "stopped" | undefined;
  } {
  const [reply, setReply] = useState<LiveReply | null>(null);
  // The latest observer, read at each event: the controller lives as long as the draft.
  const observer = useRef(observe);
  useEffect(() => { observer.current = observe; }, [observe]);
  const live = useMemo(() => liveReplyController({ draftId, storage: tabStorage, show: setReply,
    observe: (executionId, event) => observer.current?.(executionId, event) }), [draftId]);
  const reopenGraceOver = useReopenGrace(history?.activeExecution);
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

  return {
    ...live, reply, reopenGraceOver,
    phase: reply ? (reply.stopped ? "stopped" : reply.phase) : null,
    stopLocal: (executionId: string) => stoppedHere(tabStorage(), draftId).includes(executionId) ? "stopped" : undefined,
    // V2-12: a turn-path reply has no user stop (hasNoUserStop); the old stop of an execution is gone.
    stopAction: null,
  };
}
