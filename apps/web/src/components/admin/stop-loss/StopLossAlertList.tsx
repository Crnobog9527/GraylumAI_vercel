/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { describeAlert, formatTime, stopLossErrorMessage, type StopLossAlert } from './stopLossFormat';

/** Read-only list of the latest stop-loss alerts (aggregates only, no user identifiers). */
export function StopLossAlertList() {
  const alerts = trpc.runtimeRateLimits.stopLossAlerts.useQuery(undefined, { refetchOnMount: 'always' });
  const rows = (alerts.data?.alerts ?? []) as StopLossAlert[];
  return <section aria-labelledby="stop-loss-alerts-title" className="space-y-3 rounded-md border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="stop-loss-alerts-title" className="font-medium">止损告警（最近 {alerts.data?.limit ?? 100} 条）</h3>
      <Button variant="outline" size="sm" disabled={alerts.isFetching} onClick={() => { void alerts.refetch(); }}>
        {alerts.isFetching ? '读取中…' : '刷新'}
      </Button>
    </div>
    <p className="text-sm">外部通知（邮件、消息等）还没有接入，告警只显示在这里。</p>
    {alerts.error ? <p role="alert">{stopLossErrorMessage(alerts.error, 'read')}</p>
      : !alerts.data ? <p>读取中…</p>
        : rows.length === 0 ? <p data-testid="stop-loss-alerts-empty">暂无止损告警。</p>
          : <ul className="divide-y" data-testid="stop-loss-alerts">
            {rows.map(alert => {
              const text = describeAlert(alert);
              return <li key={alert.id} className="space-y-1 py-2">
                <p className="font-medium">{text.title}</p>
                {text.detail && <p className="text-sm">{text.detail}</p>}
                <p className="text-xs">{text.day ? `统计日：${text.day}，` : ''}记录时间：{formatTime(alert.created_at)}</p>
              </li>;
            })}
          </ul>}
  </section>;
}
