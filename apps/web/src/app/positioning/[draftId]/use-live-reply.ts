/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useState } from "react";
import type { LiveReply } from "./agent-turn-display";
import { liveReplyController, type LiveReplyController } from "./live-reply-controller";
import { executionSettled, type RecoveryHistory } from "./step-recovery";

function tabStorage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The page's live mentor reply (see live-reply-controller.ts) bound to React state and page lifecycle events. */
export function useLiveReply(draftId: string, history: RecoveryHistory | undefined): LiveReplyController & { reply: LiveReply | null } {
  const [reply, setReply] = useState<LiveReply | null>(null);
  const live = useMemo(() => liveReplyController({ draftId, storage: tabStorage, show: setReply }), [draftId]);
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
  // A waiting copy whose execution history already shows finished gives way to the stored reply.
  const waitingId = reply?.phase === "waiting" ? reply.executionId : null;
  const settled = Boolean(waitingId && executionSettled(history, waitingId));
  useEffect(() => {
    if (settled && waitingId) live.settle(waitingId);
  }, [live, settled, waitingId]);
  return { ...live, reply };
}
