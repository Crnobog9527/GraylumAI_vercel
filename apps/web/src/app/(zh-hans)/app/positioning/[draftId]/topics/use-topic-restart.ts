/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef } from 'react';
import { REBIND_OPENING_INPUT, rebindFailureMessage, rebindOpeningRequestId, topicFailureMessage } from './topic-notices';

type Request = { draftId: string; requestId: string; input: string };
type Bound = { sourceVersionId?: string; sourceAllowed?: boolean } | undefined;

/**
 * Starting the topic work (first time, or again on the latest positioning after an update) and, for the second case, the one opening
 * message that follows once the re-bound workspace is current and ready. The opening's request id depends only on the draft and the new
 * version, so a double click, a refresh or a second browser never opens a second turn. Returns the `start` the page calls.
 */
export function useTopicRestart(o: { draftId: string; stale: boolean; sessionId: string; ready: boolean; current?: string; bound: Bound;
  bind: { mutateAsync: (v: { draftId: string; sourceVersionId: string }) => Promise<{ sourceVersionId: string }> };
  refetch: () => Promise<unknown>; setError: (message: string) => void; send: (request: Request) => void }) {
  const wanted = useRef(false);
  const { draftId, stale, sessionId, ready, bound, send } = o;
  useEffect(() => {
    const versionId = bound?.sourceVersionId;
    if (!wanted.current || stale || !sessionId || !ready || !versionId || !bound?.sourceAllowed) return;
    wanted.current = false;
    void rebindOpeningRequestId(draftId, versionId).then(requestId => send({ draftId, requestId, input: REBIND_OPENING_INPUT }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, sessionId, ready, bound?.sourceVersionId, bound?.sourceAllowed]);
  return async function start() {
    o.setError('');
    if (!o.current) return;
    try {
      const accepted = await o.bind.mutateAsync({ draftId, sourceVersionId: o.current });
      if (accepted.sourceVersionId !== o.current) throw new Error('OPC_TOPIC_SOURCE_CHANGED');
      if (stale) wanted.current = true; // the workspace was behind: after it re-binds, the first message goes out once
      await o.refetch();
    } catch (cause) { o.setError(stale ? rebindFailureMessage(cause) : topicFailureMessage(cause)); }
  };
}
