/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from "react";
import { ResearchCallList } from "@/components/research/research-call-list";
import type { ResearchCall } from "@/components/research/research-model";
import { TurnStepList } from "@/components/chat-display/turn-step-list";
import { REOPENED_HINT, slowHint } from "@/components/chat-display/turn-steps-model";
import hintStyles from "@/components/chat-display/turn-steps.module.css";
import type { ReplyStep } from "@/components/chat-display/turn-step-list-model";
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

/** A reassurance line for a turn that takes long, or the note that a reopened turn goes on in the background. */
function TurnHint({ reopened, quiet }: { reopened: boolean; quiet: boolean }) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 5000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const hint = quiet ? null : reopened ? REOPENED_HINT : slowHint(elapsed);
  return hint ? <p className={hintStyles.hint} data-turn-hint>{hint}</p> : null;
}

/**
 * The steps of one running mentor turn: streamed here (`live`), or still advancing on the server after a reload
 * (its `notice` is the reopened one). Always lists the turn's research calls; the step list (TurnStepList) only while it runs.
 * The stage notices (reading, organizer, saving, ...) stay in mentor-notices.
 */
export function MentorTurnSteps({ live, reply, execution, calls, stale = false }: {
  live: LiveReply | null; reply: { text: string; notice?: ReplyNotice }; calls: readonly ResearchCall[];
  /** The execution (a reply); its `steps` are what the server kept for it, read back after a reload. */
  execution?: { executionId: string; state: string; steps?: readonly ReplyStep[] | null };
  /** The reopen grace period is over: an open organizer is no longer shown as "still in the background". */
  stale?: boolean;
}) {
  const streaming = Boolean(live) && !live!.finished && !live!.stopped && !["incomplete", "waiting", "stopped"].includes(live!.phase);
  // A same-tab reload restores the shown text as a "waiting" prefix: the stream is gone, so it counts as reopened.
  const here = Boolean(live) && live!.phase !== "waiting";
  const open = Boolean(execution) && ["prepared", "running"].includes(execution!.state);
  // Not streamed here but still advancing on the server: a restored prefix, the reopened notice, or a saved main reply whose organizer is open.
  const noticed = !here && reply.notice?.text === REOPENED_HINT;
  const reopened = !here && !live?.stopped && (noticed || (Boolean(live) && !stale && open));
  // The benchmark's searches are already rows of the research list below: not listed twice. A card-only reply has no text, but once
  // the organizer or the save runs the reply is written, so the list folds instead of "thinking" on.
  const shownSteps = (here ? live!.steps ?? [] : []).filter(step => !(step.tool === "research" && calls.length > 0));
  const later = here && (live!.phase === "organizer" || live!.phase === "saving");
  // A reply that has ended keeps its steps above it, folded to "已完成 N 个步骤": the ones this page watched, else the ones the server kept.
  const ended = (here && live!.steps?.length ? live!.steps : execution?.steps ?? [])
    .filter(step => step.state !== "running" && !(step.tool === "research" && calls.length > 0));
  return <>
    <ResearchCallList calls={calls}/>
    {(streaming || reopened) ? <>
      <TurnStepList steps={shownSteps} live hasText={Boolean(reply.text.trim()) || later}/>
      <TurnHint reopened={reopened} quiet={noticed}/>
    </> : <TurnStepList steps={ended}/>}
  </>;
}
