/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { TriangleAlert } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };
const muted = { color: 'var(--text-tertiary)' };
const KIND = { deletion: '删除账号', takeover_disconnect: '被他人接管后断开' } as const;
const STATE = { applied: '已完成的连接', abandoned: '放弃的连接' } as const;
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

/**
 * 外部待处理（PUBLISH-MONITOR 方案第 9 节第 25 项）：Post for Me 那边的清理连续失败 50 次后不再自动重试，列在这里。
 * 先到 Post for Me 后台按账号编号人工处理（或确认对方已恢复），再点“重新排队”，下一次定时任务会重新尝试。
 */
export function PublishMonitorStuckCleanup() {
  const stuck = trpc.publishMonitor.admin.stuck.useQuery(undefined, { staleTime: 0, retry: false });
  const requeue = trpc.publishMonitor.admin.requeue.useMutation({ onSuccess: () => void stuck.refetch() });
  return (
    <Card data-testid="admin-publish-monitor-stuck" style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <TriangleAlert className="h-5 w-5" style={{ color: 'var(--warning)' }} />外部待处理
        </CardTitle>
        <CardDescription style={muted}>
          Post for Me 的删除、断开或清理连续失败 50 次后停止自动重试。先到 Post for Me 后台按账号编号处理，再点“重新排队”。
          连接请求的清理停下后，每日孤儿清扫仍会兜底。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm" style={{ color: 'var(--text-primary)' }}>
        {stuck.isLoading ? <p style={muted}>正在读取…</p> : !stuck.data ? (
          <div className="space-y-2">
            <p role="alert" style={{ color: 'var(--color-destructive)' }}>暂时读不到，请稍后再试。</p>
            <Button variant="outline" onClick={() => void stuck.refetch()}>重新读取</Button>
          </div>
        ) : stuck.data.connections.length + stuck.data.requests.length === 0 ? <p style={muted}>没有待处理的记录。</p> : (
          <>
            {stuck.data.connections.length > 0 && (
              <table className="w-full text-left text-xs" aria-label="停止重试的账号清理">
                <thead><tr style={muted}><th className="py-1 pr-2">类型</th><th className="py-1 pr-2">平台</th>
                  <th className="py-1 pr-2">Post for Me 账号编号</th><th className="py-1 pr-2">次数</th><th className="py-1 pr-2">错误码</th>
                  <th className="py-1 pr-2">最后一次</th><th /></tr></thead>
                <tbody>{stuck.data.connections.map(c => (
                  <tr key={c.id} className="border-t" style={{ borderColor: 'var(--border-primary)' }}>
                    <td className="py-1 pr-2">{KIND[c.kind]}</td><td className="py-1 pr-2">{c.platform}</td>
                    <td className="py-1 pr-2 font-mono">{c.providerAccountId ?? '—'}</td><td className="py-1 pr-2">{c.attempts}</td>
                    <td className="py-1 pr-2 font-mono">{c.error ?? '—'}</td><td className="py-1 pr-2">{time(c.updatedAt)}</td>
                    <td className="py-1"><Button size="sm" variant="outline" disabled={requeue.isPending}
                      onClick={() => requeue.mutate({ kind: 'connection', id: c.id })}>重新排队</Button></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            {stuck.data.requests.length > 0 && (
              <table className="w-full text-left text-xs" aria-label="停止重试的连接请求清理">
                <thead><tr style={muted}><th className="py-1 pr-2">连接请求</th><th className="py-1 pr-2">平台</th>
                  <th className="py-1 pr-2">带回的账号编号</th><th className="py-1 pr-2">次数</th><th className="py-1 pr-2">错误码</th>
                  <th className="py-1 pr-2">创建时间</th><th /></tr></thead>
                <tbody>{stuck.data.requests.map(r => (
                  <tr key={r.id} className="border-t" style={{ borderColor: 'var(--border-primary)' }}>
                    <td className="py-1 pr-2">{STATE[r.state]}</td><td className="py-1 pr-2">{r.platform}</td>
                    <td className="py-1 pr-2 font-mono">{r.providerAccountIds.join(', ') || '—'}</td><td className="py-1 pr-2">{r.attempts}</td>
                    <td className="py-1 pr-2 font-mono">{r.error ?? '—'}</td><td className="py-1 pr-2">{time(r.createdAt)}</td>
                    <td className="py-1"><Button size="sm" variant="outline" disabled={requeue.isPending}
                      onClick={() => requeue.mutate({ kind: 'request', id: r.id })}>重新排队</Button></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </>
        )}
        {requeue.data && <p role="status">{requeue.data.requeued ? '已重新排队，下一次定时任务会再试。' : '这条记录已经不需要处理了。'}</p>}
        {requeue.error && <p role="alert" style={{ color: 'var(--color-destructive)' }}>重新排队没有成功，请稍后再试。</p>}
      </CardContent>
    </Card>
  );
}
