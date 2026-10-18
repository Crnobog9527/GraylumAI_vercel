/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LiveReply } from '@/app/positioning/[draftId]/agent-turn-display';
import type { WorkItem } from '@/components/chat-display/agent-work-model';
import { toolCounts, type TurnProgressInput } from '@/components/chat-display/turn-steps-model';

/**
 * The step list input for one work-conversation turn, or null when the turn is not running.
 * Streamed here: the live reply decides the phase. Not streamed here but still open on the server (a reload): `reopened`.
 */
export function runtimeTurnProgress(args: {
  turnState: string; reply: LiveReply | null; executionId: string; streaming: boolean; items: readonly WorkItem[];
}): { input: TurnProgressInput; reopened: boolean } | null {
  const live = args.reply?.executionId === args.executionId ? args.reply : null;
  const tools = toolCounts(args.items.map(item => item.state));
  if (live && args.streaming && !live.stopped && !live.finished && !['incomplete', 'waiting', 'stopped'].includes(live.phase))
    return { input: { phase: live.phase, hasText: Boolean(live.text), tools }, reopened: false };
  if (!args.streaming && ['prepared', 'running'].includes(args.turnState))
    return { input: { phase: 'mentor', hasText: false, tools }, reopened: true };
  return null;
}
