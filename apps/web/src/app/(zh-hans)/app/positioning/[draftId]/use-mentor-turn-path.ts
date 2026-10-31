/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentTurnEvent, AgentTurnOutcome } from "@repo/api/src/shared/agentTurn";
import type { ChatNotice } from "@/components/chat/ChatInlineNotice";
import { TURN_CONTINUE, TURN_PAUSED_NOTICE } from "@/app/(zh-hans)/app/runtime/turn-notices";
import type { TurnView } from "@repo/api/src/services/turn/view";
import { trpc } from "@/trpc/client";
import { RUNTIME_CHOICES_STALE_MS } from "@/lib/runtime-choices";
import type { MentorRequest } from "./mentor-turn";
import { isTurnExecution, mentorTurnBody, mentorTurnEvents, readTurnView, stepOpened, turnHistory, type TurnHistory } from "./mentor-turn-path";

const READ_MS = 3000;
const fetcher: typeof fetch = (...args) => globalThis.fetch(...args);

/** CORE-PATH-V2 V2-10: the turn path's side of the positioning page. Off, it adds nothing and the page runs on the old path. */
export function useMentorTurnPath(sessionId: string | undefined) {
  const choices = trpc.runtime.choices.useQuery(sessionId ? { sessionId } : undefined, { enabled: Boolean(sessionId), staleTime: RUNTIME_CHOICES_STALE_MS });
  const on = Boolean(sessionId && choices.data?.corePathV2);
  const [view, setView] = useState<TurnView | null>(null);
  const reload = useCallback(async () => {
    if (!on || !sessionId) return null;
    const next = await readTurnView(sessionId, fetcher);
    if (next) setView(next);
    return next;
  }, [on, sessionId]);
  useEffect(() => { void reload(); }, [reload]);
  const active = Boolean(view?.activeTurn);
  useEffect(() => {
    if (!active || view?.activeTurn?.pauseReason) return;
    const timer = setInterval(() => void reload(), READ_MS);
    return () => clearInterval(timer);
  }, [active, view?.activeTurn?.pauseReason, reload]);

  const projected = useMemo(() => view ? turnHistory(view) : { executions: [], turns: [], activeExecution: null }, [view]);
  const history = useRef<TurnHistory>(projected);
  history.current = projected;
  const merged = useRef<{ old?: unknown; projected?: unknown; data?: unknown }>({});
  const paused = view?.activeTurn?.pauseReason === "waiting_credits" ? view.activeTurn : null;
  return { on, turns: projected.turns, owns: isTurnExecution, stepOpened,
    /** 继续 after a pause for credits: the server has what was asked, so any device can press it. */
    notices(stream: (open: () => Promise<AsyncIterable<AgentTurnEvent>>) => void): ChatNotice[] {
      if (!paused) return [];
      return [{ id: "turn-paused", tone: "warning", text: TURN_PAUSED_NOTICE, actions: [{ label: TURN_CONTINUE, onClick: () => stream(async () =>
        mentorTurnEvents({ kind: "resume", sessionId, requestId: crypto.randomUUID(), resumeOf: paused.turnId })) }] }];
    },
    /** The draft as the old path read it, plus the turn path's bindings. */
    draft<T extends { turns?: unknown[] } | undefined>(draft: T): T {
      return draft && { ...draft, turns: [...(draft.turns ?? []), ...projected.turns] };
    },
    /** The stream of one mentor request: POST /api/turn with the switch on, the old stream otherwise. */
    open<T>(request: MentorRequest, draft: { sessionId: string; moduleId?: string | null } | undefined, old: () => Promise<T>) {
      if (!on) return old;
      return async () => mentorTurnEvents(mentorTurnBody(request, { sessionId: draft!.sessionId, moduleId: draft!.moduleId! }, history.current));
    },
    /** The old view, with this conversation's turns after its executions; refetching reads both. */
    withOld<T extends { data?: unknown; refetch: () => Promise<unknown> }>(old: T): T {
      if (!on) return old;
      // One object per change: the page's effects depend on this data.
      if (merged.current.old !== old.data || merged.current.projected !== projected) {
        const data = old.data as { executions?: unknown[]; activeExecution?: string | null } | undefined;
        merged.current = { old: old.data, projected, data: data && { ...data, executions: [...(data.executions ?? []), ...projected.executions],
          activeExecution: data.activeExecution ?? projected.activeExecution } };
      }
      return { ...old, data: merged.current.data, refetch: async () => { await reload(); return old.refetch(); } };
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
