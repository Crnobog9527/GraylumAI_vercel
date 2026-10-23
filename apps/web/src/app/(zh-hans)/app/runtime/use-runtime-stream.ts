/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useMemo, useState } from 'react';
import type { AgentTurnEvent, AgentTurnOutcome } from '@repo/api/src/shared/agentTurn';
import { trpc } from '@/trpc/client';
import type { LiveReply } from '@/app/(zh-hans)/app/positioning/[draftId]/agent-turn-display';
import { liveReplyController, type LiveReplyController } from '@/app/(zh-hans)/app/positioning/[draftId]/live-reply-controller';
import { TEXT_PROTOCOL } from '@/app/(zh-hans)/app/positioning/[draftId]/mentor-turn';
import type { StopRequest } from '@/app/(zh-hans)/app/positioning/[draftId]/stop-reply';
import { workItemFromResearchCall, workItemsOf, type WorkItem } from '@/components/chat-display/agent-work-model';
import { isLibrarySourceDeleted } from './gate-notices';

type OpenStream = (executionId: string) => Promise<AsyncIterable<AgentTurnEvent>>;

/** The last stream that delivered a result, in the shape `finishedExecution` reads from a mutation. */
export type StreamCall = { isSuccess: boolean; data?: AgentTurnOutcome; variables?: { executionId: string } };

/**
 * Run one admitted execution over `runtime.executeStream` and show its text as it arrives
 * (CHAT-NATIVE-OUTPUT, Owner 2026-10-03 "全站统一流式"). It replaces `runtime.execute` with the
 * same input and the same outcome: the server runs the same original execution either way, so
 * request ids, one execution per request and one charge per execution are unchanged.
 *
 * The balance is re-read whenever a stream ends, for any reason: a finished turn may have
 * settled a charge. A lost stream throws (STREAM_INTERRUPTED) like a lost execute response did.
 */
export async function runStreamedExecution(live: LiveReplyController, open: OpenStream, executionId: string, handlers: {
  onResult: (executionId: string, result: AgentTurnOutcome) => void; refreshBalance: () => void;
  /** LIB-4b: the stream ended with LIB_SOURCE_DELETED; the text shown so far is already gone. */
  onSourceDeleted?: (executionId: string) => void;
}): Promise<AgentTurnOutcome> {
  try {
    const outcome = await live.stream(() => open(executionId), {
      executionId, onResult: result => handlers.onResult(executionId, result),
    });
    // The server may also end the turn with a result instead of an error: cancelled, source deleted (LIB-4b).
    if ((outcome as { unavailable?: string }).unavailable === 'source_deleted') {
      live.clear();
      handlers.onSourceDeleted?.(executionId);
    }
    return outcome;
  } catch (cause) {
    // A referenced document was deleted mid-turn: drop the half answer at once, never keep it as "waiting".
    if (isLibrarySourceDeleted(cause)) {
      live.clear();
      handlers.onSourceDeleted?.(executionId);
    }
    throw cause;
  } finally {
    handlers.refreshBalance();
  }
}

/** `runtime.executeStream` for the /runtime page: the live reply, `run` and `stop`. */
export function useRuntimeStream(sessionId: string, onResult: (executionId: string, result: AgentTurnOutcome) => void) {
  const utils = trpc.useUtils();
  const [reply, setReply] = useState<LiveReply | null>(null);
  const [active, setActive] = useState(0);
  const [last, setLast] = useState<{ executionId: string; result: AgentTurnOutcome } | null>(null);
  const [work, setWork] = useState<{sessionId: string; items: Record<string, WorkItem[]>}>({sessionId, items: {}});
  const [sourceDeleted, setSourceDeleted] = useState<string[]>([]);
  // No same-tab prefix storage here: a reload shows the saved history, as before.
  const live = useMemo(() => liveReplyController({ draftId: 'runtime:' + sessionId, storage: () => null, show: setReply,
    observe: (executionId, event) => {
      // CHAT-AUTO-CONTEXT C: a research lookup of a free chat shows as a row too (the RT-5 mapping, with its credits).
      const item = event.type === 'research_call' ? workItemFromResearchCall(event)
        : event.type === 'agent_tool' ? workItemsOf({workItems: [{...event, id: event.callId}]})[0] : undefined;
      if (!item) return;
      setWork(old => {
        const items = old.sessionId === sessionId ? old.items : {};
        const rows = new Map((items[executionId] ?? []).map(row => [row.id, row]));
        if (rows.size < 12 || rows.has(item.id)) rows.set(item.id, item);
        return {sessionId, items: {...items, [executionId]: [...rows.values()]}};
      });
    } }),
    [sessionId]);
  async function stream(executionId: string, open: OpenStream) {
    setActive(count => count + 1);
    setLast(null);
    try {
      return await runStreamedExecution(live, open, executionId, {
        onResult: (id, result) => { setLast({ executionId: id, result }); onResult(id, result); },
        refreshBalance: () => void utils.credits.getBalance.invalidate(),
        onSourceDeleted: id => setSourceDeleted(ids => ids.includes(id) ? ids : [...ids, id]),
      });
    } finally {
      setActive(count => count - 1);
    }
  }
  const run = (executionId: string) =>
    stream(executionId, id => utils.client.runtime.executeStream.mutate({ executionId: id, textProtocol: TEXT_PROTOCOL }));
  /** 继续 a BILL-PAYG pause with its own cursor/epoch token; same execution, streamed like `run`. */
  const resume = (token: { executionId: string; cursor: number; epoch: number }) =>
    stream(token.executionId, () => utils.client.runtime.resumeStream.mutate({ ...token, textProtocol: TEXT_PROTOCOL }));
  const call: StreamCall = last ? { isSuccess: true, data: last.result, variables: { executionId: last.executionId } }
    : { isSuccess: false };
  return {
    workItems: work.sessionId === sessionId ? work.items : {},
    reply, run, resume, call, streaming: active > 0,
    /** Executions whose stream here ended because a referenced library document was deleted. */
    sourceDeleted,
    /**
     * 停止 freezes the shown text and returns the stop request that keeps exactly it (stopAt/source), or
     * null when nothing streams here; the page then sends a plain cancel, as before.
     */
    freeze: (executionId: string): StopRequest | null => live.stop(executionId),
  };
}
