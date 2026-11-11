'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JOB_OPEN, jobSummary, platformName, publishErrorMessage, type JobState } from '@/lib/publish-monitor/publish-flow';
import { trpc } from '@/trpc/client';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { dateTimeLabel, zoneLabel } from '@/lib/publish-schedule/schedule-view';
import styles from './publish.module.css';

/**
 * One publish job, read from the server only (never a media link). An open job is re-read every 15 seconds from our
 * database; "刷新状态" asks Post for Me through the server. A finished job offers a new attempt (a fresh upload), for the failed platforms only.
 */
const TARGET_LABEL = { pending: '等待结果', published: '已发布', failed: '失败' } as const;

export function PublishStatus({ jobId, onRetry, onDone }: { jobId: string; onRetry: (connectionIds: string[]) => void; onDone: () => void }) {
  const job = trpc.publishMonitor.publish.job.useQuery({ jobId }, {
    retry: false, refetchInterval: query => (query.state.data && JOB_OPEN(query.state.data.state as JobState) ? 15_000 : false),
  });
  const refresh = trpc.publishMonitor.publish.refresh.useMutation({ onSuccess: () => job.refetch() });
  if (job.isLoading) return <PageSkeleton compact rows={2} label="发布状态读取中" />;
  if (job.error || !job.data) {
    return <p role="alert" className={styles.error}>{publishErrorMessage(job.error?.message, job.error?.data?.code)}</p>;
  }
  const data = job.data;
  const state = data.state as JobState;
  const open = JOB_OPEN(state);
  const scheduledAt = typeof data.scheduledAt === 'string' ? data.scheduledAt : null;
  const retryable = state === 'failed' || state === 'released'
    || (state === 'completed' && data.targets.some(t => t.status === 'failed'));
  return (
    <section aria-label="发布结果" className={styles.card}>
      <p role="status" className={styles.statusLine}>{jobSummary(state, data.manualReview)}</p>
      {state === 'scheduled' && scheduledAt && <p className={styles.hint}>
        发布时间：{dateTimeLabel(scheduledAt)}（{zoneLabel()}）。发布前 10 分钟之前可以在<Link
          href="/app/publish-schedule">发布排期</Link>里改期或取消。</p>}
      <ul className={styles.results}>
        {data.targets.map(target => (
          <li key={target.connectionId} className={styles.result}>
            <span className={styles.tile} aria-hidden>{platformName(target.platform).slice(0, 1).toUpperCase()}</span>
            <strong>{platformName(target.platform)}</strong>
            {target.status === 'published' && target.url && (
              <a href={target.url} target="_blank" rel="noopener noreferrer">查看帖子</a>
            )}
            <span className={styles.badge} data-status={target.status}>
              {target.status === 'published' ? <Check size={12} aria-hidden /> : target.status === 'failed' ? <X size={12} aria-hidden /> : null}
              {TARGET_LABEL[target.status]}</span>
          </li>
        ))}
      </ul>
      <div className={styles.stack}>
        {data.chargedCredits !== null && <p className={styles.hint}>本次扣除 {data.chargedCredits} 积分。</p>}
        {data.chargedCredits === null && data.holdCredits !== null && (open || state === 'scheduled') && (
          <p className={styles.hint}>暂时冻结 {data.holdCredits} 积分，结果确定后只按成功的平台扣，其余退回。</p>
        )}
        {refresh.error && <p role="alert" className={styles.error}>
          {publishErrorMessage(refresh.error.message, refresh.error.data?.code)}</p>}
        <div className={styles.rowActions}>
          {open && <Button variant="outline" disabled={refresh.isPending}
            onClick={() => refresh.mutate({ jobId })}>{refresh.isPending ? '正在查询……' : '刷新状态'}</Button>}
          {retryable && <Button onClick={() => onRetry(state === 'completed'
            ? data.targets.filter(t => t.status === 'failed').map(t => t.connectionId)
            : data.targets.map(t => t.connectionId))}>
            {state === 'completed' ? '重发失败的平台（会重新上传素材）' : '重新发布（会重新上传素材）'}</Button>}
          {!open && <Button variant="outline" onClick={onDone}>完成</Button>}
        </div>
      </div>
    </section>
  );
}
