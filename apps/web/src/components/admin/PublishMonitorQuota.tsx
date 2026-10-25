'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { trpc } from '@/trpc/client';

/**
 * PUBLISH-MONITOR admin: this Post for Me billing period's publish count, to compare with Post for Me's own usage report.
 * One count is one platform that was delivered (what Post for Me bills); posts made at Post for Me outside Graylum are not here.
 */
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export function PublishMonitorQuota() {
  const quota = trpc.publishMonitor.admin.quota.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  return (
    <section aria-label="发布条数" className="space-y-1 rounded-lg border border-zinc-700 p-4 text-sm">
      <h2 className="font-medium">本周期发布条数（对照 Post for Me 用量）</h2>
      {quota.isLoading && <p className="text-zinc-400">读取中…</p>}
      {quota.error && <p role="alert" className="text-red-400">暂时读不到发布条数，请稍后重试。</p>}
      {quota.data && !quota.data.configured && (
        <p className="text-zinc-400">还没有设置套餐条数（后台设置 publish_monitor_publish_quota），所以现在不能发布。</p>
      )}
      {quota.data?.configured && (
        <>
          <p>本周期已成功发送 <strong>{quota.data.used}</strong> 条 / 上限 <strong>{quota.data.limit}</strong> 条
            （冻结中 {quota.data.reserved} 条），周期 {day(quota.data.periodStart)} 至 {day(quota.data.periodEnd)}（不含最后一天）。</p>
          <p className="text-zinc-400">一条 = 一个平台发布成功，和 Post for Me 的计法相同；只统计从 Graylum 发出的，
            不含你直接在 Post for Me 里发的。到 80% 会在 Sentry 报警，到上限暂停新发布。</p>
        </>
      )}
    </section>
  );
}
