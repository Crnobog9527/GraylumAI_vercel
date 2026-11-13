/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ReportPaywallDialog } from '@/components/paywall/ReportPaywallDialog';
import { planOnlyTag } from '@/components/paywall/goldScenePaywallCopy';
import { fusionPlanLevel, pickPaywallPlans } from '@/components/paywall/paywallPlans';
import { JURY_ENTRY_PARAM } from './JuryChooser';
import { trpc } from '@/trpc/client';
import { estimateFusion, startJury } from '@/lib/turn-fusion';
import { resolveSeatNames, SEATS } from '@/components/landing/preview-jury/jury-events';
import { ACTIVE, reviewHref, startErrorText, toPanel } from './review-adapter';
import styles from './jury-entry.module.css';
import { READ_RETRY } from '@/trpc/read-retry';
import { QueryNotice } from '@/components/opc/query-notice';
import { PageSkeleton } from '@/components/ui/page-skeleton';

const codeOf = (error: unknown) => (error instanceof Error ? error.message : '');
type Estimate = { estimateCredits?: number; requiredCredits?: number; maxRounds?: number };

/**
 * What the review does, in the order it happens. A debate round is said only when the administrator's setting allows one
 * (maxRounds 2, from the estimate); with one round the reviewers' opinions go straight to the summary seat.
 */
export function juryProcessText(input: { reviewers: string[]; summary: string; maxRounds?: number }): string {
  const debate = (input.maxRounds ?? 1) >= 2 ? '意见不一的地方再辩论一轮，' : '';
  return `${input.reviewers.length} 位评审（${input.reviewers.join('、')}）会各自读完你的定位报告、提出修改意见，`
    + `${debate}最后由${input.summary}逐条裁决、写出修订稿。用不用修订稿，由你逐章决定。`;
}

/** The price (POST /api/turn/estimate), read when the card opens. */
function useTurnEstimate(on: boolean, draftId: string, sourceVersionId: string) {
  const [state, setState] = useState<{ data?: Estimate; error?: unknown; fetching: boolean; tick: number }>({ fetching: false, tick: 0 });
  useEffect(() => {
    if (!on) return;
    let current = true;
    setState(old => ({ ...old, fetching: true, error: undefined }));
    estimateFusion<Estimate>({ kind: 'jury', draftId, sourceVersionId })
      .then(data => { if (current) setState(old => ({ ...old, data, fetching: false })); },
        error => { if (current) setState(old => ({ ...old, error, fetching: false })); });
    return () => { current = false; };
  }, [on, draftId, sourceVersionId, state.tick]);
  return { data: state.data, error: state.error, isFetching: state.fetching,
    refetch: () => setState(old => ({ ...old, tick: old.tick + 1 })) };
}

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
  const available = trpc.fusionReview.available.useQuery(undefined, { staleTime: 60_000, ...READ_RETRY });
  const enabled = available.data?.enabled === true;
  // The server's own membership answer (the same one a start is refused by): a plan without the jury sees the entry as
  // Gold-only and goes straight to the upgrade page instead of being told only after pressing 开始评审 (Owner 2026-10-20).
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { enabled, staleTime: 60_000, ...READ_RETRY });
  const goldOnly = entitlements.data?.allowFusionReview === false;
  const mine = trpc.fusionReview.mine.useQuery({ draftId, limit: 1 }, { enabled, staleTime: 15_000, ...READ_RETRY });
  const panel = trpc.fusionReview.panel.useQuery(undefined, { enabled, staleTime: Infinity, ...READ_RETRY });
  const [starting, setStarting] = useState(false);
  const start = { isPending: starting };
  const [open, setOpen] = useState(false);
  // The Gold paywall opens on this page (Owner 2026-10-25).
  const [paywall, setPaywall] = useState(false);
  // From the rail's 评审团 entry (JuryChooser, ?jury=1): the card opens by itself, once, and is brought into view.
  const card = useRef<HTMLElement>(null);
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || !enabled || entitlements.data?.allowFusionReview !== true) return;
    arrived.current = true;
    if (new URLSearchParams(window.location.search).has(JURY_ENTRY_PARAM)) setOpen(true);
  }, [enabled, entitlements.data]);
  useEffect(() => { if (open && arrived.current) card.current?.scrollIntoView({ block: 'nearest' }); }, [open]);
  // Which plan carries the jury, from the plan catalog (never a fixed "Gold"); asked only for a member without it.
  const plans = trpc.settings.getMembershipPlans.useQuery(undefined, { enabled: enabled && entitlements.data?.allowFusionReview === false,
    staleTime: 300_000, ...READ_RETRY });
  // The fixed price of a review and the balance a start needs (0294), shown before the user agrees.
  const estimate = useTurnEstimate(enabled && open, draftId, sourceVersionId);
  const cap = estimate.data?.estimateCredits;
  const required = estimate.data?.requiredCredits;
  const [error, setError] = useState('');
  const requestId = useRef('');
  // The switch could not be read even after its retries: say so instead of dropping the entry.
  if (available.isError && !available.data) return <QueryNotice error={available.error} label="评审团" retry={() => available.refetch()} />;
  if (!enabled) return null;
  const latest = mine.data?.[0];
  const names = resolveSeatNames(toPanel(panel.data));
  // The panel as the server has it: how many reviewers and what they are called are set by administrators.
  const seats = toPanel(panel.data)?.reviewers.map(item => item.seat) ?? SEATS;

  if (latest && ACTIVE.has(latest.state)) {
    return <Link className={styles.link} href={reviewHref(draftId, latest.reviewId)}>
      {latest.state === 'paused' ? '评审团已暂停，去看看 →' : '评审团正在审阅，去看看 →'}</Link>;
  }
  if (goldOnly) {
    // A review already paid for stays reachable after a downgrade; only starting a new one is Gold-only.
    return <>
      <Button variant="outline" disabled={busy} onClick={() => setPaywall(true)}>
        请评审团审阅报告<span className={styles.gold}>{planOnlyTag(fusionPlanLevel(pickPaywallPlans(plans.data), 'jury'))}</span></Button>
      {paywall && <ReportPaywallDialog scene="jury" onClose={() => setPaywall(false)} />}
      {latest ? <Link className={styles.link} href={reviewHref(draftId, latest.reviewId)}>
        {ACTIVE.has(latest.state) ? '评审团正在审阅，去看看 →' : latest.awaitingChoice ? '评审完成，去逐章选择 →' : '查看上次评审 →'}</Link> : null}
    </>;
  }
  const begin = async () => {
    if (start.isPending) return;
    setError('');
    requestId.current ||= crypto.randomUUID();
    if (!cap) return;
    try {
      setStarting(true);
      const review = await startJury({ requestId: requestId.current, draftId, sourceVersionId, acceptedCredits: cap }).finally(() => setStarting(false));
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
        <section ref={card} className={styles.card} aria-label="评审团">
          <p>{juryProcessText({ reviewers: seats.map(seat => names[seat]), summary: names.S, maxRounds: estimate.data?.maxRounds })}</p>
          <p>大约需要 3–4 分钟，开始后可以离开页面。</p>
          {cap ? <>
            <p className={styles.cap}>本次评审 <b>{cap.toLocaleString('zh-CN')}</b> 积分。生成修订稿才扣，没有生成修订稿全额退回。</p>
            {required && required > cap ? <p>开始时可用积分需要至少 {required.toLocaleString('zh-CN')}：
              其中 {(required - cap).toLocaleString('zh-CN')} 是评审过程中每一步的临时冻结，这一步结束就退回。</p> : null}
          </> : estimate.error ? <p role="alert" className={styles.error}>{startErrorText(codeOf(estimate.error))}</p>
            : <PageSkeleton compact rows={1} label="评审价格读取中"/>}
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
