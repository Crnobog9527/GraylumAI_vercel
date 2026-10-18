/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from "react";
import { ResearchCallList } from "@/components/research/research-call-list";
import type { ResearchCall } from "@/components/research/research-model";
import { TurnSteps } from "@/components/chat-display/turn-steps";
import { toolCounts } from "@/components/chat-display/turn-steps-model";
import { REOPENED_HINT } from "@/components/chat-display/turn-steps-model";
import type { LiveReply, ReplyNotice } from "./agent-turn-display";

/** How long a reloaded page trusts that the server is still advancing an open turn before it asks for a check. */
export const REOPEN_GRACE_MS = 180_000;

/** False for the first REOPEN_GRACE_MS after the page opened, then true. */
export function useReopenGrace(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setOver(true), REOPEN_GRACE_MS);
    return () => clearTimeout(timer);
  }, []);
  return over;
}

/**
 * The small steps of one running mentor turn: streamed here (`live`), or still advancing on the server after a reload
 * (its `notice` is the reopened one). Always lists the turn's research calls; the steps only while it runs.
 */
export function MentorTurnSteps({ live, notice, hasText, calls }: {
  live: LiveReply | null; notice?: ReplyNotice; hasText: boolean; calls: readonly ResearchCall[];
}) {
  const streaming = Boolean(live) && !live!.finished && !live!.stopped && !["incomplete", "waiting", "stopped"].includes(live!.phase);
  // The turn's own notice says "reopened" (reopenedTurn in agent-turn-display.ts): the server still advances it.
  const reopened = !live && notice?.text === REOPENED_HINT;
  return <>
    <ResearchCallList calls={calls}/>
    {(streaming || reopened) && <TurnSteps reopened={reopened}
      progress={{ phase: live?.phase ?? "mentor", hasText, tools: toolCounts(calls.map(call => call.state)) }}/>}
  </>;
}
