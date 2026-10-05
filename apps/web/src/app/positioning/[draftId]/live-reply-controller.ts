/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { AgentTurnEvent, AgentTurnOutcome } from "@repo/api/src/shared/agentTurn";
import { liveReplyAfter, startLiveReply, type LiveReply } from "./agent-turn-display";
import {
  forgetLivePrefix, markLiveReload, PREFIX_WRITE_INTERVAL_MS, releaseRestoredPrefix, restoreLivePrefix, saveLivePrefix,
  unmarkLiveReload,
} from "./live-prefix";
import { readAgentTurn } from "./mentor-turn";
import { isPaygWaiting } from "@/lib/payg-wait";
import { stopRequestFor, type StopRequest } from "./stop-reply";

type PrefixStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The positioning page's live mentor reply and its same-tab copy
 * (CHAT-NATIVE-OUTPUT §2.4), without React so the rules are testable. A
 * snapshot (offset 0 or a new `rev`) is stored before it is shown; normal
 * growth is stored at most once a second, and `pagehide` stores the latest
 * text with the reload mark. A same-tab reload shows the stored prefix, not
 * growing, with the waiting state until the final reply replaces it.
 * 停止 freezes the shown reply and stores it at once (stop-reply.ts).
 */
export function liveReplyController(options: {
  draftId: string;
  /** This tab's sessionStorage, or null when it cannot be used (private mode, server render). */
  storage: () => PrefixStorage | null;
  show: (reply: LiveReply | null) => void;
  now?: () => number;
}) {
  const { draftId, storage } = options;
  const now = options.now ?? Date.now;
  let current: LiveReply | null = null;
  let lastWrite = Number.NEGATIVE_INFINITY;
  /** Executions whose stream this page is reading now. */
  const reading = new Map<string, number>();
  const read = (executionId: string, delta: number) => {
    const count = (reading.get(executionId) ?? 0) + delta;
    if (count > 0) reading.set(executionId, count);
    else reading.delete(executionId);
  };
  const show = (next: LiveReply | null) => {
    current = next;
    options.show(next);
  };
  const forget = () => {
    const target = storage();
    if (target) forgetLivePrefix(target, draftId);
    releaseRestoredPrefix(draftId);
  };
  const live = {
    current: () => current,
    /** True while this page reads the stream of `executionId`; it then delivers the result itself. */
    streaming: (executionId: string) => reading.has(executionId),
    /**
     * 停止: freeze what is shown, store it at once and return the stop request
     * (null when there is nothing live to stop or it was already stopped).
     */
    stop(executionId: string): StopRequest | null {
      if (!current || current.executionId !== executionId || current.stopped || current.phase === "incomplete") return null;
      const next: LiveReply = { ...current, stopped: true, stalled: true };
      const target = storage();
      if (target) saveLivePrefix(target, draftId, next);
      show(next);
      return stopRequestFor(next);
    },
    /** Page load: show the prefix this same tab stored before reloading, if any. */
    restore() {
      const target = storage();
      const restored = target && restoreLivePrefix(target, draftId);
      if (restored && !current) show(restored);
    },
    /** `pagehide`: keep the latest shown text with the reload mark. */
    pageHide() {
      const target = storage();
      if (target) markLiveReload(target, draftId, current);
    },
    /** `pageshow` from the back/forward cache: the page lived on, withdraw the mark. */
    pageShow(persisted: boolean) {
      const target = storage();
      if (persisted && target) unmarkLiveReload(target, draftId);
    },
    /** A stream for `executionId` starts. The same execution keeps what it shows (a lost connection, a reload). */
    begin(executionId: string) {
      if (current?.executionId === executionId) return;
      forget();
      show(startLiveReply(executionId));
    },
    apply(executionId: string, event: AgentTurnEvent) {
      const old = current;
      const next = liveReplyAfter(old, executionId, event);
      if (!next || next === old) return;
      const replaced = event.type === "textDelta" && (event.offset === 0 || next.rev !== old?.rev);
      const target = storage();
      const at = now();
      if (target && next.text !== old?.text && (replaced || at - lastWrite >= PREFIX_WRITE_INTERVAL_MS)) {
        // A snapshot is stored before it is shown; when that fails the item is gone instead of stale.
        saveLivePrefix(target, draftId, next);
        lastWrite = at;
      }
      show(next);
    },
    /**
     * The stream ended without a completed result. `waiting`: the execution may
     * still be running; keep what is shown, not growing, and its stored copy.
     * `incomplete`: it finished without a reply, so nothing is kept for a reload.
     */
    mark(executionId: string, phase: "waiting" | "incomplete") {
      if (current?.executionId !== executionId) return;
      // A stopped reply keeps what was shown until history holds its saved result.
      if (current.stopped) phase = "waiting";
      if (phase === "incomplete") forget();
      show({ ...current, phase, stalled: true });
    },
    /** The final reply is shown from history; drop the live copy. */
    clear() {
      forget();
      show(null);
    },
    /** History shows `executionId` finished: a waiting or stopped copy of it gives way to the stored reply. */
    settle(executionId: string) {
      if (current?.executionId === executionId && (current.phase === "waiting" || current.stopped)) live.clear();
    },
    /**
     * Read one turn's stream into the live reply and return its outcome. A
     * resumed execution passes its id, a new turn learns it from `admitted`.
     */
    async stream(open: () => Promise<AsyncIterable<AgentTurnEvent>>, handlers: {
      executionId?: string; onAdmitted?: (id: string) => void; onFinished?: () => void; onResult?: (result: AgentTurnOutcome) => void;
    }) {
      let id = handlers.executionId, result: AgentTurnOutcome | undefined;
      if (id) {
        live.begin(id);
        read(id, 1);
      }
      try {
        ({ result } = await readAgentTurn(await open(), {
          executionId: handlers.executionId,
          onAdmitted: admitted => { id = admitted; read(admitted, 1); live.begin(admitted); handlers.onAdmitted?.(admitted); },
          onProgress: (execution, event) => live.apply(execution, event),
          onFinished: handlers.onFinished,
        }));
        handlers.onResult?.(result);
        return result;
      } finally {
        if (id) read(id, -1);
        // A lost stream or a still-running execution waits (a stopped turn still saving too); a finished one
        // without a completed result says so. A BILL-PAYG pause is not unfinished: history shows its notice.
        if (id && result?.state !== "completed" && !isPaygWaiting(result?.state))
          live.mark(id, !result || result.state === "pending" || result.state === "stopping" ? "waiting" : "incomplete");
        // The result is stored: 停止 would change nothing any more, so it goes away at once, before history catches up.
        else if (id && current?.executionId === id) show({ ...current, finished: true });
      }
    },
  };
  return live;
}

export type LiveReplyController = ReturnType<typeof liveReplyController>;
