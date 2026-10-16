/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { trpc } from '@/trpc/client';
import { ENDED, type RawDetail, type RawEvents, type RawPanel } from './review-adapter';

/** How often the page reads new events while the review runs, and hands the review to the server again. */
const EVENTS_MS = 4_000;
const DETAIL_MS = 15_000;
const NUDGE_MS = 30_000;

export type LiveReview = {
  detail: { data: RawDetail | undefined; error: { message: string; data?: { code?: string } | null } | null; refetch: () => Promise<unknown> };
  events: { data: RawEvents | undefined };
  panel: { data: RawPanel | undefined };
  /** Nothing more will run. */
  ended: boolean;
};

/**
 * Everything the review page reads. The server advances the review (FUSION-BACKGROUND); the page only reads: the
 * events for the animation, the owner's full record, and the seat names. While the review runs, `continue` hands it
 * to the server again now and then (a no-op while the server holds it); it never claims or pays for a call.
 */
export function useLiveReview(reviewId: string): LiveReview {
  const detail = trpc.fusionReview.detail.useQuery({ reviewId }, {
    retry: 1, refetchOnWindowFocus: false,
    refetchInterval: query => (query.state.data && ENDED.has(query.state.data.state) ? false : DETAIL_MS),
  });
  const ended = Boolean(detail.data && ENDED.has(detail.data.state));
  const events = trpc.fusionReview.events.useQuery({ reviewId }, {
    retry: 1, refetchOnWindowFocus: false,
    // A review that ended may still wait for the user's chapter choice; nothing more plays, so stop reading.
    refetchInterval: query => (query.state.data?.ended || query.state.data?.events.some(event => event.type === 'review_ended')
      ? false : EVENTS_MS),
  });
  const panel = trpc.fusionReview.panel.useQuery(undefined, { staleTime: Infinity, retry: 1 });
  const nudge = trpc.fusionReview.continue.useMutation();
  const nudgeNow = nudge.mutate;
  const loaded = Boolean(detail.data);

  useEffect(() => {
    if (!loaded || ended) return;
    nudgeNow({ reviewId });
    const timer = window.setInterval(() => nudgeNow({ reviewId }), NUDGE_MS);
    return () => window.clearInterval(timer);
  }, [reviewId, loaded, ended, nudgeNow]);

  // New events mean new opinions or a new state: read the full record again.
  const count = events.data?.events.length ?? 0;
  const refetchDetail = detail.refetch;
  useEffect(() => { if (count > 0) void refetchDetail(); }, [count, refetchDetail]);

  return {
    detail: { data: detail.data, error: detail.error, refetch: detail.refetch },
    events: { data: events.data }, panel: { data: panel.data }, ended,
  };
}
