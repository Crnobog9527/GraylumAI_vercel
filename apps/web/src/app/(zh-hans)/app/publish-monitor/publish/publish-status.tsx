'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JOB_OPEN, jobSummary, platformName, publishErrorMessage, type JobState } from '@/lib/publish-monitor/publish-flow';
import { trpc } from '@/trpc/client';

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
  if (job.isLoading) return <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (job.error || !job.data) {
    return <p role="alert" className="text-sm">{publishErrorMessage(job.error?.message, job.error?.data?.code)}</p>;
  }
  const data = job.data;
  const state = data.state as JobState;
  const open = JOB_OPEN(state);
  const retryable = state === 'failed' || state === 'released'
    || (state === 'completed' && data.targets.some(t => t.status === 'failed'));
  return (
    <section aria-label="发布结果" className="space-y-3">
      <p role="status" className="text-sm">{jobSummary(state, data.manualReview)}</p>
      <ul className="space-y-1 text-sm">
        {data.targets.map(target => (
          <li key={target.connectionId} className="flex items-center gap-2">
            <span className="w-28">{platformName(target.platform)}</span>
            <span>{TARGET_LABEL[target.status]}</span>
            {target.status === 'published' && target.url && (
              <a className="underline" href={target.url} target="_blank" rel="noopener noreferrer">查看帖子</a>
            )}
          </li>
        ))}
      </ul>
      {data.chargedCredits !== null && <p className="text-sm text-[var(--text-secondary)]">本次扣除 {data.chargedCredits} 积分。</p>}
      {data.chargedCredits === null && data.holdCredits !== null && open && (
        <p className="text-sm text-[var(--text-secondary)]">暂时冻结 {data.holdCredits} 积分，结果确定后只按成功的平台扣，其余退回。</p>
      )}
      {refresh.error && <p role="alert" className="text-sm text-[var(--color-error)]">
        {publishErrorMessage(refresh.error.message, refresh.error.data?.code)}</p>}
      <div className="flex flex-wrap gap-2">
        {open && <Button variant="outline" disabled={refresh.isPending}
          onClick={() => refresh.mutate({ jobId })}>{refresh.isPending ? '正在查询……' : '刷新状态'}</Button>}
        {retryable && <Button onClick={() => onRetry(state === 'completed'
          ? data.targets.filter(t => t.status === 'failed').map(t => t.connectionId)
          : data.targets.map(t => t.connectionId))}>
          {state === 'completed' ? '重发失败的平台（会重新上传素材）' : '重新发布（会重新上传素材）'}</Button>}
        {!open && <Button variant="outline" onClick={onDone}>完成</Button>}
      </div>
    </section>
  );
}
