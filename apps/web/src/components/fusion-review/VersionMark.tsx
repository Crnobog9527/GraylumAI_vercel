/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/trpc/client';
import { reviewHref } from './review-adapter';
import styles from './version-mark.module.css';

/** What fusionReview.versionMarks returns for one report version (none for an ordinary report). */
export type VersionMarkData = { mark: 'reviewed' | 'derived'; reviewId: string | null; draftId: string | null;
  reviewedAt: string | null; adoptedCount: number; derivedFrom: string | null };

export const MARK_TEXT = { reviewed: '已评审', derived: '衍生', derivedHint: '基于评审过的版本修改而来', seeReview: '查看评审意见' } as const;
const day = (value: string | null) => { const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '日期未记录'; };

/**
 * One call for every analysis on the page (a whole library at once): the marks by version id. A failed read shows no
 * mark and no error: a mark only tells apart reports that used the jury, it never blocks anything.
 */
export function useVersionMarks(draftIds: Array<string | null | undefined>, versionIds: string[] = []):
  Record<string, VersionMarkData> {
  const ids = [...new Set(draftIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].sort().slice(0, 500);
  const shown = [...new Set(versionIds)].sort().slice(0, 2000);
  const input = { draftIds: ids, ...(shown.length ? { versionIds: shown } : {}) };
  const marks = trpc.fusionReview.versionMarks.useQuery(input, { enabled: ids.length > 0, retry: false, staleTime: 60_000,
    refetchOnWindowFocus: false });
  return (marks.data ?? {}) as Record<string, VersionMarkData>;
}

/** "已评审" (solid; click for the review's date, how many chapters were adopted, and the review itself) or "衍生" (outlined). */
export function VersionMark({ mark, inert = false }: { mark: VersionMarkData | null | undefined;
  /** Inside something already clickable (a card): the same badge as plain text, the details are one click away in the dialog. */
  inert?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!mark) return null;
  if (inert && mark.mark === 'reviewed') return <span className={`${styles.badge} ${styles.reviewed}`}>{MARK_TEXT.reviewed}</span>;
  if (mark.mark === 'derived') {
    return <span className={`${styles.badge} ${styles.derived}`} title={MARK_TEXT.derivedHint} aria-label={`${MARK_TEXT.derived}：${MARK_TEXT.derivedHint}`}>
      {MARK_TEXT.derived}</span>;
  }
  return (
    <span className={styles.wrap}>
      <button type="button" className={`${styles.badge} ${styles.reviewed}`} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {MARK_TEXT.reviewed}</button>
      {open ? (
        <span className={styles.panel} role="group" aria-label="评审情况">
          <p>评审日期：{day(mark.reviewedAt)}</p>
          <p>采用了 {mark.adoptedCount} 章修订</p>
          {mark.reviewId && mark.draftId ? <Link href={reviewHref(mark.draftId, mark.reviewId)}>{MARK_TEXT.seeReview} →</Link> : null}
        </span>
      ) : null}
    </span>
  );
}
