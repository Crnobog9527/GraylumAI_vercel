/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from "react";
import { ResearchCallList } from "@/components/research/research-call-list";
import type { ResearchCall } from "@/components/research/research-model";
import { TurnSteps } from "@/components/chat-display/turn-steps";
import { REOPENED_HINT, toolCounts } from "@/components/chat-display/turn-steps-model";
import { openOrganizer, type PaygTurn } from "@/lib/payg-wait";
import type { LiveReply, ReplyNotice } from "./agent-turn-display";

/** How long a reloaded page trusts that the server is still advancing an open turn before it asks for a check. */
export const REOPEN_GRACE_MS = 180_000;

/** False for REOPEN_GRACE_MS after `turnId` (the page's active execution) appeared, then true; a new turn restarts it. */
export function useReopenGrace(turnId?: string | null): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    setOver(false);
    const timer = setTimeout(() => setOver(true), REOPEN_GRACE_MS);
    return () => clearTimeout(timer);
  }, [turnId]);
  return over;
}

/**
 * The small steps of one running mentor turn: streamed here (`live`), or still advancing on the server after a reload
 * (its `notice` is the reopened one). Always lists the turn's research calls; the steps only while it runs.
 */
export function MentorTurnSteps({ live, reply, execution, calls }: {
  live: LiveReply | null; reply: { text: string; notice?: ReplyNotice }; execution?: PaygTurn; calls: readonly ResearchCall[];
}) {
  const streaming = Boolean(live) && !live!.finished && !live!.stopped && !["incomplete", "waiting", "stopped"].includes(live!.phase);
  // Not streamed here but still advancing on the server: the reopened notice, or a saved main reply whose organizer is open.
  const organizing = !live && Boolean(execution) && openOrganizer(execution!) && ["prepared", "running"].includes(execution!.state);
  // The turn's own notice already says "还在后台处理"; the steps then stay quiet so it is shown once.
  const reopened = !live && (reply.notice?.text === REOPENED_HINT || organizing);
  return <>
    <ResearchCallList calls={calls}/>
    {(streaming || reopened) && <TurnSteps reopened={reopened} quiet={!live && reply.notice?.text === REOPENED_HINT}
      progress={{ phase: live?.phase ?? (organizing ? "organizer" : "mentor"), hasText: Boolean(reply.text),
        tools: toolCounts(calls.map(call => call.state)) }}/>}
  </>;
}
