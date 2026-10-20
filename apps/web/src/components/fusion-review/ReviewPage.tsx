/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { cn } from '@/lib/utils';
import { trpc } from '@/trpc/client';
import { resolveSeatNames } from '@/components/landing/preview-jury/jury-events';
import { Toolbar } from '@/components/landing/preview-jury/JuryToolbar';
import pageStyles from '@/components/landing/preview-jury/jury.module.css';
import { playableEvents, toCaseReport, toJuryDetail, toPanel, toReaderSource } from './review-adapter';
import { ReviewLive } from './ReviewLive';
import { ReviewResult } from './ReviewResult';
import { useLiveReview } from './use-live-review';
import styles from './review-page.module.css';

const codeOf = (error: unknown) => (error instanceof Error ? error.message : '');

/**
 * /positioning/<draftId>/review/<reviewId>: one review of one positioning analysis, at its own address so a refresh
 * or a link comes back to it. The server runs the review; this page reads it, plays it, and shows the result.
 */
export function ReviewPage({ draftId, reviewId }: { draftId: string; reviewId: string }) {
  const router = useRouter();
  const { detail, events, panel, ended } = useLiveReview(reviewId);
  const drafts = trpc.opc.list.useQuery(undefined, { staleTime: 60_000 });
  const account = (drafts.data?.drafts as { draftId: string; businessName?: string }[] | undefined)
    ?.find(item => item.draftId === draftId)?.businessName ?? '';
  const back = `/app/positioning/${draftId}`;
  const raw = detail.data;
  const names = useMemo(() => resolveSeatNames(toPanel(panel.data)), [panel.data]);
  const jury = useMemo(() => (raw ? toJuryDetail(raw) : null), [raw]);
  const source = useMemo(() => (raw ? toReaderSource(raw) : null), [raw]);
  const report = useMemo(() => (raw ? toCaseReport(raw, account) : null), [raw, account]);
  const played = useMemo(() => playableEvents(events.data?.events ?? []), [events.data]);
  // A review that had already ended when the page opened goes straight to the result.
  const endedOnArrival = useRef<boolean | null>(null);
  if (endedOnArrival.current === null && raw) endedOnArrival.current = ended;
  const refetch = detail.refetch;
  const reload = useCallback(() => { void refetch(); }, [refetch]);

  const shell = (extra: ReactNode, body: ReactNode) => (
    <div className={cn(light.light, pageStyles.page)}>
      <Toolbar>
        <nav aria-label="面包屑" className={pageStyles.crumbs}>
          <Link href={back}><ArrowLeft size={15} aria-hidden="true" />返回：我的定位分析{account ? ` · ${account}` : ''}</Link>
        </nav>
        <h1 className={pageStyles.title}>{!raw ? '评审团' : ended ? '评审团的结果' : '评审团正在审阅你的定位报告'}</h1>
        {raw ? <Controls state={raw.state} /> : null}
        {extra}
      </Toolbar>
      {body}
    </div>
  );

  // Not this user's review, or not one of this analysis: the same plain message, nothing about why.
  const missing = detail.error && ['FORBIDDEN', 'NOT_FOUND', 'BAD_REQUEST'].includes(detail.error.data?.code ?? '')
    || codeOf(detail.error) === 'FUSION_REVIEW_DENIED' || (raw && raw.draftId !== draftId);
  if (missing) return shell(null, <main className={styles.main}><p className={styles.state}>找不到这次评审。<Link href={back}>回到定位分析</Link></p></main>);
  if (detail.error) {
    return shell(null, <main className={styles.main}><p className={styles.state} role="alert">评审暂时读不到，请稍后刷新页面。
      <button type="button" className={styles.linkButton} onClick={reload}>重新读取</button></p></main>);
  }
  if (!raw || !jury || !source || !report || !events.data) {
    return shell(null, <main className={styles.main}><p className={styles.state} role="status">正在读取评审…</p></main>);
  }
  const result = <ReviewResult draftId={draftId} detail={jury} source={source} names={names} fee={raw.fee} onChanged={reload} />;
  if (endedOnArrival.current) return shell(null, <main className={styles.main}>{result}</main>);
  return (
    <ReviewLive reviewId={reviewId} events={played} detail={jury} names={names} report={report} ended={ended}
      frame={shell} onLeave={() => router.push(back)} result={result} />
  );
}

/** No stop or end (Owner 2026-10-17: "评审团功能不提供中途停止的选项，用户只要点了启用，他就必须得用完"). A paused review
 * says why and goes on by itself; it can only end on its own (finished, failed, or the content deleted). */
function Controls({ state }: { state: string }) {
  if (state !== 'paused') return null;
  return (
    <p className={styles.paused} role="status">
      评审暂停了，通常是可用积分不够下一步的临时冻结。充值后回到这里会接着进行，已经完成的意见不会丢，也不会重复扣费。
    </p>
  );
}
