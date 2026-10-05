/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState } from "react";
import type { AgentTurnEvent, AgentTurnOutcome } from "@repo/api/src/shared/agentTurn";
import { liveReplyAfter, startLiveReply, type LiveReply } from "./agent-turn-display";
import {
  forgetLivePrefix, markLiveReload, PREFIX_WRITE_INTERVAL_MS, releaseRestoredPrefix, restoreLivePrefix, saveLivePrefix,
  unmarkLiveReload,
} from "./live-prefix";
import { readAgentTurn } from "./mentor-turn";
import { executionSettled, type RecoveryHistory } from "./step-recovery";

type PrefixStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStorage(): PrefixStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The positioning page's live mentor reply and its same-tab copy
 * (CHAT-NATIVE-OUTPUT §2.4). A snapshot (offset 0 or a new `rev`) is stored
 * before it is shown; normal growth is stored at most once a second, and
 * `pagehide` stores the latest text with the reload mark. A same-tab reload
 * shows the stored prefix, not growing, with the waiting state until the
 * final reply replaces it.
 */
export function useLiveReply(draftId: string, history: RecoveryHistory | undefined) {
  const [reply, setReply] = useState<LiveReply | null>(null);
  const current = useRef<LiveReply | null>(null);
  const lastWrite = useRef(0);
  const show = (next: LiveReply | null) => {
    current.current = next;
    setReply(next);
  };
  useEffect(() => {
    const storage = tabStorage();
    const restored = storage && restoreLivePrefix(storage, draftId);
    if (restored && !current.current) show(restored);
    const hide = () => {
      const target = tabStorage();
      if (target) markLiveReload(target, draftId, current.current);
    };
    const reshow = (event: PageTransitionEvent) => {
      const target = tabStorage();
      if (event.persisted && target) unmarkLiveReload(target, draftId);
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", reshow);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", reshow);
    };
  }, [draftId]);
  // A waiting copy whose execution history already shows finished gives way to the stored reply.
  const waitingId = reply?.phase === "waiting" ? reply.executionId : null;
  const settled = Boolean(waitingId && executionSettled(history, waitingId));
  useEffect(() => {
    if (!settled || current.current?.executionId !== waitingId) return;
    const storage = tabStorage();
    if (storage) forgetLivePrefix(storage, draftId);
    releaseRestoredPrefix(draftId);
    show(null);
  }, [settled, waitingId, draftId]);

  const live = {
    reply,
    /** A stream for `executionId` starts. The same execution keeps what it shows (a lost connection, a reload). */
    begin(executionId: string) {
      if (current.current?.executionId === executionId) return;
      const storage = tabStorage();
      if (storage) forgetLivePrefix(storage, draftId);
      releaseRestoredPrefix(draftId);
      show(startLiveReply(executionId));
    },
    apply(executionId: string, event: AgentTurnEvent) {
      const old = current.current;
      const next = liveReplyAfter(old, executionId, event);
      if (!next || next === old) return;
      const replaced = event.type === "textDelta" && (event.offset === 0 || next.rev !== old?.rev);
      const storage = tabStorage();
      const now = Date.now();
      if (storage && next.text !== old?.text && (replaced || now - lastWrite.current >= PREFIX_WRITE_INTERVAL_MS)) {
        // A snapshot is stored before it is shown; when that fails the item is gone instead of stale.
        saveLivePrefix(storage, draftId, next);
        lastWrite.current = now;
      }
      show(next);
    },
    /**
     * The stream ended without a completed result. `waiting`: the execution may
     * still be running; keep what is shown and its stored copy. `incomplete`:
     * it is finished without a reply, so nothing is kept for a reload.
     */
    mark(executionId: string, phase: "waiting" | "incomplete") {
      const old = current.current;
      if (old?.executionId !== executionId) return;
      if (phase === "incomplete") {
        const storage = tabStorage();
        if (storage) forgetLivePrefix(storage, draftId);
      }
      show({ ...old, phase, stalled: true });
    },
    /** The final reply is shown from history; drop the live copy. */
    clear() {
      const storage = tabStorage();
      if (storage) forgetLivePrefix(storage, draftId);
      releaseRestoredPrefix(draftId);
      show(null);
    },
    /**
     * Read one turn's stream into the live reply and return its outcome. A
     * resumed execution passes its id, a new turn learns it from `admitted`.
     * A lost stream or a still-running execution waits without growing; a
     * finished one without a completed result says so.
     */
    async stream(open: () => Promise<AsyncIterable<AgentTurnEvent>>, handlers: {
      executionId?: string; onAdmitted?: (id: string) => void; onFinished?: () => void; onResult?: (result: AgentTurnOutcome) => void;
    }) {
      let current = handlers.executionId, result: AgentTurnOutcome | undefined;
      if (current) live.begin(current);
      try {
        ({ result } = await readAgentTurn(await open(), {
          executionId: handlers.executionId,
          onAdmitted: id => { current = id; live.begin(id); handlers.onAdmitted?.(id); },
          onProgress: (id, event) => live.apply(id, event),
          onFinished: handlers.onFinished,
        }));
        handlers.onResult?.(result);
        return result;
      } finally {
        if (current && result?.state !== "completed") live.mark(current, !result || result.state === "pending" ? "waiting" : "incomplete");
      }
    },
  };
  return live;
}
