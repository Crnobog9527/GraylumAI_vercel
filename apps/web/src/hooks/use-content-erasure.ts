'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  ERASURE_CHANNEL, announceErasure, classifyErasureError, confirmContentErasure, forgetLocalCopies,
  refreshAfterErasure, type ContentErasurePreview, type ContentErasureTarget,
} from '@/lib/content-erasure';

function browserStores(): Array<Storage | null> {
  if (typeof window === 'undefined') return [];
  const read = (get: () => Storage) => {
    try { return get(); } catch { return null; }
  };
  return [read(() => window.localStorage), read(() => window.sessionStorage)];
}

/** Clears every cached view of the deleted object here, in other tabs and in local drafts. */
export function useAfterContentErasure() {
  const utils = trpc.useUtils();
  return useCallback(async (target: ContentErasureTarget) => {
    forgetLocalCopies(target.id, browserStores());
    announceErasure(target);
    await refreshAfterErasure(utils);
  }, [utils]);
}

/** Another tab deleted something: refetch here so it disappears from every list. */
export function useContentErasureSync(onErased?: (target: ContentErasureTarget) => void) {
  const utils = trpc.useUtils();
  const callback = useRef(onErased);
  useEffect(() => { callback.current = onErased; });
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(ERASURE_CHANNEL);
    channel.onmessage = (event: MessageEvent<ContentErasureTarget>) => {
      void refreshAfterErasure(utils);
      if (event.data && typeof event.data.id === 'string') callback.current?.(event.data);
    };
    return () => channel.close();
  }, [utils]);
}

export type ContentErasureState = {
  preview: ContentErasurePreview | null;
  loading: boolean;
  previewError: string;
  confirming: boolean;
  message: string;
  messageTone: 'error' | 'notice' | 'done';
  finished: boolean;
};

/** Preview, then confirm the exact previewed scope. The caller leaves deleted content when the dialog closes. */
export function useContentErasure(target: ContentErasureTarget | null) {
  const afterErasure = useAfterContentErasure();
  const previewQuery = trpc.account.contentErasurePreview.useQuery(target ?? { kind: 'answer', id: '' }, {
    enabled: Boolean(target), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false,
  });
  const confirmMutation = trpc.account.contentErasureConfirm.useMutation();
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<ContentErasureState['messageTone']>('notice');
  const [finished, setFinished] = useState(false);
  const key = target ? target.kind + ':' + target.id : '';
  const handled = useRef('');
  useEffect(() => { setMessage(''); setFinished(false); }, [key]);

  const preview = target && previewQuery.data?.id === target.id ? previewQuery.data : null;
  const previewFailure = previewQuery.error ? classifyErasureError(previewQuery.error, 'preview') : null;
  const alreadyGone = Boolean(preview?.alreadyDeleted) || previewFailure?.type === 'gone';
  useEffect(() => {
    if (!target || !alreadyGone || handled.current === key) return;
    // Deleted elsewhere (another tab or an earlier attempt): refresh and leave it, once per target.
    handled.current = key;
    void afterErasure(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, alreadyGone]);

  const confirm = useCallback(async () => {
    if (!preview || confirmMutation.isPending || finished) return;
    setMessage('');
    const outcome = await confirmContentErasure({ confirm: (input) => confirmMutation.mutateAsync(input), afterErasure }, preview);
    setMessage(outcome.message);
    if (outcome.type === 'done') {
      handled.current = key;
      setMessageTone(outcome.reviewRequired ? 'notice' : 'done');
      setFinished(true);
    } else if (outcome.type === 'changed') {
      setMessageTone('notice');
      await previewQuery.refetch();
    } else {
      setMessageTone('error');
    }
  }, [preview, confirmMutation, finished, afterErasure, previewQuery, key]);

  const state: ContentErasureState = {
    preview,
    loading: Boolean(target) && previewQuery.isFetching,
    previewError: previewFailure && previewFailure.type !== 'gone' ? previewFailure.message : '',
    confirming: confirmMutation.isPending,
    message: message || (alreadyGone && !finished ? '这项内容已经永久删除。' : ''),
    messageTone: message ? messageTone : 'done',
    finished: finished || alreadyGone,
  };
  return { state, confirm, retryPreview: () => previewQuery.refetch() };
}
