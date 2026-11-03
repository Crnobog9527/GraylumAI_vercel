/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentTurnEvent, AgentTurnOutcome } from "@repo/api/src/shared/agentTurn";
import type { ChatNotice } from "@/components/chat/ChatInlineNotice";
import { TURN_CONTINUE, TURN_PAUSED_NOTICE } from "@/app/(zh-hans)/app/runtime/turn-notices";
import type { TurnView } from "@repo/api/src/services/turn/view";
import { trpc } from "@/trpc/client";
import { RUNTIME_CHOICES_STALE_MS } from "@/lib/runtime-choices";
import { turnBusyForCredits } from "@/components/opc/credits-label";
import type { MentorRequest } from "./mentor-turn";
import { mentorOnTurnPath, mentorPathReady } from "./mentor-path-gate";
import {
  isTurnExecution, releaseResumedRequests, turnExecutionId, mentorTurnBody, mentorTurnEvents, readTurnView, stepOpened, turnHistory,
  type TurnHistory,
} from "./mentor-turn-path";

const READ_MS = 3000;
const fetcher: typeof fetch = (...args) => globalThis.fetch(...args);

/** CORE-PATH-V2 V2-10: the turn path's side of the positioning page. Off, it adds nothing and the page runs on the old path. */
export function useMentorTurnPath(sessionId: string | undefined, draftId: string) {
  const choices = trpc.runtime.choices.useQuery(sessionId ? { sessionId } : undefined, { enabled: Boolean(sessionId), staleTime: RUNTIME_CHOICES_STALE_MS });
  // V2-12: the turn path is the only path; the server answers TURN_CORE_DISABLED itself when its switch is off.
  const on = Boolean(sessionId);
  const [view, setView] = useState<TurnView | null>(null), [failed, setFailed] = useState(false);
  // The path is known once the switch and the turn path's read of this conversation have answered (see mentor-path-gate.ts).
  const ready = mentorPathReady({ hasSession: Boolean(sessionId), choicesSettled: choices.isSuccess || choices.isError, viewLoaded: view !== null });
  // The path decision the send reads when it fires (see mentor-path-gate.ts).
  const gate = useRef({ ready, on });
  gate.current = { ready, on };
  const reload = useCallback(async () => {
    // Read whatever the switch says: a rollback must not hide replies the turn path already saved and charged.
    if (!sessionId) return null;
    const next = await readTurnView(sessionId, fetcher);
    setFailed(!next);
    if (next) setView(next);
    return next;
  }, [sessionId]);
  useEffect(() => { void reload(); }, [reload]);
  // A read that failed (the first, or the one after a stream ended) is read again until it answers; a turn running is read until it closes.
  const active = Boolean(view?.activeTurn) || failed;
  useEffect(() => {
    if (!active || view?.activeTurn?.pauseReason) return;
    const timer = setInterval(() => void reload(), READ_MS);
    return () => clearInterval(timer);
  }, [active, view?.activeTurn?.pauseReason, reload]);

  /** However the stream ends (a pause for credits, a dropped connection), the page reads the turn's state: that is what shows the
   * continue offer, or the reply the server saved. */
  async function* readAfter<T>(events: AsyncGenerator<T>, onDone?: () => void): AsyncGenerator<T> {
    try { yield* events; onDone?.(); } finally { void reload(); }
  }

  const projected = useMemo(() => view ? turnHistory(view) : { executions: [], turns: [], activeExecution: null }, [view]);
  const history = useRef<TurnHistory>(projected);
  history.current = projected;
  const paused = view?.activeTurn?.pauseReason === "waiting_credits" ? view.activeTurn : null;
  // The sidebar balance while a turn holds its freeze (a draft or reply being made, also after a refresh): see credits-label.ts.
  const creditsBusy = Boolean(sessionId) && turnBusyForCredits({ viewRead: view !== null, viewFailed: failed, busy: Boolean(view?.activeTurn),
    paused: Boolean(paused) });
  return { on, ready, creditsBusy, turns: projected.turns, owns: isTurnExecution, stepOpened,
    /** 继续 after a pause for credits: the server has what was asked, so any device can press it. */
    notices(stream: (open: () => Promise<AsyncIterable<AgentTurnEvent>>) => void): ChatNotice[] {
      if (!paused) return [];
      return [{ id: "turn-paused", tone: "warning", text: TURN_PAUSED_NOTICE, actions: [{ label: TURN_CONTINUE, onClick: () => stream(async () =>
        readAfter(mentorTurnEvents({ kind: "resume", sessionId, requestId: crypto.randomUUID(), resumeOf: paused.turnId }),
          () => releaseResumedRequests(sessionStorage, draftId, turnExecutionId(paused.turnId)))) }] }];
    },
    /** The draft as the old path read it, plus the turn path's bindings. */
    draft<T extends { turns?: unknown[] } | undefined>(draft: T): T {
      return draft && { ...draft, turns: [...(draft.turns ?? []), ...projected.turns] };
    },
    /** The stream of one mentor request: POST /api/turn with the switch on, the old stream otherwise. */
    open(request: MentorRequest, draft: { sessionId: string; moduleId?: string | null } | undefined) {
      // Decided when the turn is sent, after the gate is ready: a send before that waits, and never falls to the old path unasked.
      return async () => {
        // V2-12: the old stream is gone; a conversation whose switch is off cannot send (the real database is built on the turn path).
        if (!await mentorOnTurnPath(() => gate.current)) throw new Error("TURN_PATH_REQUIRED");
        return readAfter(mentorTurnEvents(mentorTurnBody(request, { sessionId: draft!.sessionId, moduleId: draft!.moduleId! },
          history.current)));
      };
    },
    /** The conversation's history as the page reads it: this conversation's turns projected as executions (V2-12: the old view is gone). */
    history: {
      data: view ? { executions: projected.executions, activeExecution: projected.activeExecution } : undefined,
      isError: failed && !view,
      refetch: async () => {
        const next = await reload();
        return { data: next ? { executions: turnHistory(next).executions, activeExecution: turnHistory(next).activeExecution } : undefined,
          error: next ? null : new Error("TURN_VIEW_UNREADABLE") };
      },
    },
    /** A turn this page no longer streams (a reload, a dropped stream): wait for its close, never send again. */
    settled: async (executionId: string): Promise<AgentTurnOutcome> => {
      for (;;) {
        const next = await reload();
        if (next && !next.activeTurn) return { state: "completed", executionId };
        await new Promise(resolve => setTimeout(resolve, READ_MS));
      }
    } };
}
