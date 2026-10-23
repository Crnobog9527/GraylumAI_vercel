/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { StaleDataNotice } from './StaleDataNotice';
import { STOP_LOSS_QUERY_OPTIONS, describeAlert, describeNotice, formatTime, stopLossErrorMessage, type StopLossAlert } from './stopLossFormat';

/** Read-only list of the latest stop-loss alerts (aggregates only, no user identifiers). */
export function StopLossAlertList() {
  const alerts = trpc.runtimeRateLimits.stopLossAlerts.useQuery(undefined, STOP_LOSS_QUERY_OPTIONS);
  const rows = (alerts.data?.alerts ?? []) as StopLossAlert[];
  return <section aria-labelledby="stop-loss-alerts-title" className="space-y-3 rounded-md border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="stop-loss-alerts-title" className="font-medium">止损告警（最近 {alerts.data?.limit ?? 100} 条）</h3>
      <Button variant="outline" size="sm" disabled={alerts.isFetching} onClick={() => { void alerts.refetch(); }}>
        {alerts.isFetching ? '读取中…' : '刷新'}
      </Button>
    </div>
    <p className="text-sm">新告警会自动发邮件到“客服邮箱”（同类告警每天只发一次）；测试站只发给测试收件人。</p>
    {alerts.error && alerts.data && <StaleDataNotice onRetry={() => { void alerts.refetch(); }} />}
    {alerts.error && !alerts.data ? <p role="alert">{stopLossErrorMessage(alerts.error, 'read')}</p>
      : !alerts.data ? <p>读取中…</p>
        : rows.length === 0 ? <p data-testid="stop-loss-alerts-empty">暂无止损告警。</p>
          : <ul className="divide-y" data-testid="stop-loss-alerts">
            {rows.map(alert => {
              const text = describeAlert(alert);
              return <li key={alert.id} className="space-y-1 py-2">
                <p className="font-medium">{text.title}</p>
                {text.detail && <p className="text-sm">{text.detail}</p>}
                <p className="text-xs">{text.day ? `统计日：${text.day}，` : ''}记录时间：{formatTime(alert.created_at)}，{describeNotice(alert)}</p>
              </li>;
            })}
          </ul>}
  </section>;
}
