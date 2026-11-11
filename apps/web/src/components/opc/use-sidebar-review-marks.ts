/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { trpc } from '@/trpc/client';
import { READ_RETRY } from '@/trpc/read-retry';
import { draftMark, latestByDraft } from '@/components/fusion-review/review-adapter';

/**
 * The jury's mark on the sidebar's draft rows (" · 待选择", " · 已暂停"…). The jury may be off or unreachable, which simply shows no mark.
 *
 * Asked together with the sidebar's lists, not after them. It used to wait until the lists had come back and held a draft, which made
 * it a second request on every cold page load (staging, 2026-11-11: sent 1.2-1.9 s after the first ones, another 0.6-0.9 s to come
 * back). Asked at once it rides in the first batch: one request fewer, and the marks arrive with the rows. An account without
 * drafts gets an empty list it does not use.
 */
export function useSidebarReviewMarks(): { label: (draftId: string) => string | undefined; note: (draftId: string) => string } {
  const reviews = trpc.fusionReview.mine.useQuery({ limit: 50 }, { staleTime: 30_000, ...READ_RETRY });
  const marks = latestByDraft(Array.isArray(reviews.data) ? reviews.data : []);
  const label = (draftId: string) => draftMark(marks.get(draftId))?.label;
  return {
    /** The mark itself, for a draft row of its own. */
    label,
    /** The mark as the tail of an account row's line (" · 待选择"), or nothing. */
    note: draftId => { const mark = label(draftId); return mark ? ' · ' + mark : ''; },
  };
}
