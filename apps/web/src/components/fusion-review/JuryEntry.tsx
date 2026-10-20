/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { profileTabHref } from '@/lib/profile-tabs';
import { trpc } from '@/trpc/client';
import { resolveSeatNames, SEATS } from '@/components/landing/preview-jury/jury-events';
import { ACTIVE, reviewHref, startErrorText, toPanel } from './review-adapter';
import styles from './jury-entry.module.css';

const codeOf = (error: unknown) => (error instanceof Error ? error.message : '');

/**
 * The 评审团 entry of a positioning analysis whose formal version has a report. Switched off: nothing renders, no
 * error. A running or paused review of this analysis links to its page instead of starting another; a finished one
 * can be opened, and a new review of the current version started. Starting is one request with its own id, so a
 * retry after a lost answer finds the same review.
 */
export function JuryEntry({ draftId, report, busy }: {
  draftId: string;
  /** The formal version's report (opc.read): only a published version with a report can be reviewed. */
  report: { available?: boolean; id?: string | null } | null | undefined;
  busy: boolean;
}) {
  const sourceVersionId = report?.available && report.id ? report.id : '';
  return sourceVersionId ? <ReportJury draftId={draftId} sourceVersionId={sourceVersionId} busy={busy} /> : null;
}

function ReportJury({ draftId, sourceVersionId, busy }: { draftId: string; sourceVersionId: string; busy: boolean }) {
  const router = useRouter();
  const available = trpc.fusionReview.available.useQuery(undefined, { staleTime: 60_000, retry: false });
  const enabled = available.data?.enabled === true;
  // The server's own membership answer (the same one a start is refused by): a plan without the jury sees the entry as
  // Gold-only and goes straight to the upgrade page instead of being told only after pressing 开始评审 (Owner 2026-10-20).
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { enabled, staleTime: 60_000, retry: false });
  const goldOnly = entitlements.data?.allowFusionReview === false;
  const mine = trpc.fusionReview.mine.useQuery({ draftId, limit: 1 }, { enabled, retry: false, staleTime: 15_000 });
  const panel = trpc.fusionReview.panel.useQuery(undefined, { enabled, staleTime: Infinity, retry: false });
  const start = trpc.fusionReview.start.useMutation();
  const [open, setOpen] = useState(false);
  // The fixed price of a review and the balance a start needs (0294), shown before the user agrees.
  const estimate = trpc.fusionReview.estimate.useQuery({ draftId, sourceVersionId }, { enabled: enabled && open, retry: false,
    staleTime: 0, refetchOnWindowFocus: false });
  const cap = estimate.data?.estimateCredits;
  const required = estimate.data?.requiredCredits;
  const [error, setError] = useState('');
  const requestId = useRef('');
  if (!enabled) return null;
  const latest = mine.data?.[0];
  const names = resolveSeatNames(toPanel(panel.data));
  // The panel as the server has it: how many reviewers and what they are called are set by administrators.
  const seats = toPanel(panel.data)?.reviewers.map(item => item.seat) ?? SEATS;

  if (goldOnly) {
    return <Button variant="outline" disabled={busy} onClick={() => void window.open(profileTabHref('subscription'), '_blank', 'noopener')}>
      请评审团审阅报告<span className={styles.gold}>Gold 专享</span></Button>;
  }
  if (latest && ACTIVE.has(latest.state)) {
    return <Link className={styles.link} href={reviewHref(draftId, latest.reviewId)}>
      {latest.state === 'paused' ? '评审团已暂停，去看看 →' : '评审团正在审阅，去看看 →'}</Link>;
  }
  const begin = async () => {
    if (start.isPending) return;
    setError('');
    requestId.current ||= crypto.randomUUID();
    if (!cap) return;
    try {
      const review = await start.mutateAsync({ requestId: requestId.current, draftId, sourceVersionId, acceptedCredits: cap });
      router.push(reviewHref(draftId, review.reviewId));
    } catch (cause) {
      const code = codeOf(cause);
      // A refusal is final for this request; only a lost answer keeps the id so the retry finds the same review.
      if (/^(FUSION|REPORT)_[A-Z_]+$/.test(code)) requestId.current = '';
      setError(startErrorText(code));
      void mine.refetch();
      if (code === 'FUSION_REVIEW_ESTIMATE_CHANGED' || code === 'FUSION_REVIEW_PRICE_CHANGED') void estimate.refetch();
    }
  };
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={() => { setOpen(value => !value); setError(''); }} aria-expanded={open}>
        请评审团审阅报告
      </Button>
      {latest ? <Link className={styles.link} href={reviewHref(draftId, latest.reviewId)}>
        {latest.awaitingChoice ? '评审完成，去逐章选择 →' : '查看上次评审 →'}</Link> : null}
      {open ? (
        <section className={styles.card} aria-label="评审团">
          <p>
            {seats.length} 位评审（{seats.map(seat => names[seat]).join('、')}）会各自读完你的定位报告、提出修改意见，
            意见不一的地方再辩论一轮，最后由{names.S}逐条裁决、写出修订稿。用不用修订稿，由你逐章决定。
          </p>
          <p>大约需要 3–4 分钟，开始后可以离开页面。</p>
          {cap ? <>
            <p className={styles.cap}>本次评审 <b>{cap.toLocaleString('zh-CN')}</b> 积分。生成修订稿才扣，没有生成修订稿全额退回。</p>
            {required && required > cap ? <p>开始时可用积分需要至少 {required.toLocaleString('zh-CN')}：
              其中 {(required - cap).toLocaleString('zh-CN')} 是评审过程中每一步的临时冻结，这一步结束就退回。</p> : null}
          </> : estimate.error ? <p role="alert" className={styles.error}>{startErrorText(codeOf(estimate.error))}</p>
            : <p role="status">正在读取评审价格…</p>}
          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={start.isPending}>先不用</Button>
            <Button onClick={() => void begin()} disabled={busy || start.isPending || !cap || estimate.isFetching}>{start.isPending ? '正在开始…' : '开始评审'}</Button>
          </div>
        </section>
      ) : null}
    </>
  );
}
