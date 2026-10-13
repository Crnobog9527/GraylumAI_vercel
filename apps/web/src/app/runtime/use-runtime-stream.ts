/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useMemo, useState } from 'react';
import type { AgentTurnEvent, AgentTurnOutcome } from '@repo/api/src/shared/agentTurn';
import { trpc } from '@/trpc/client';
import type { LiveReply } from '@/app/positioning/[draftId]/agent-turn-display';
import { liveReplyController, type LiveReplyController } from '@/app/positioning/[draftId]/live-reply-controller';
import { TEXT_PROTOCOL } from '@/app/positioning/[draftId]/mentor-turn';

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
}): Promise<AgentTurnOutcome> {
  try {
    return await live.stream(() => open(executionId), {
      executionId, onResult: result => handlers.onResult(executionId, result),
    });
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
  // No same-tab prefix storage here: a reload shows the saved history, as before.
  const live = useMemo(() => liveReplyController({ draftId: 'runtime:' + sessionId, storage: () => null, show: setReply }),
    [sessionId]);
  async function run(executionId: string) {
    setActive(count => count + 1);
    setLast(null);
    try {
      return await runStreamedExecution(live,
        id => utils.client.runtime.executeStream.mutate({ executionId: id, textProtocol: TEXT_PROTOCOL }), executionId, {
          onResult: (id, result) => { setLast({ executionId: id, result }); onResult(id, result); },
          refreshBalance: () => void utils.credits.getBalance.invalidate(),
        });
    } finally {
      setActive(count => count - 1);
    }
  }
  const call: StreamCall = last ? { isSuccess: true, data: last.result, variables: { executionId: last.executionId } }
    : { isSuccess: false };
  return {
    reply, run, call, streaming: active > 0,
    /** 停止 freezes the shown text; the page still sends its own cancel. */
    freeze: (executionId: string) => void live.stop(executionId),
  };
}
