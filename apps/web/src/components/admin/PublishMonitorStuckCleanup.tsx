/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
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
  const resolve = trpc.publishMonitor.admin.resolve.useMutation({ onSuccess: () => void stuck.refetch() });
  const [confirming, setConfirming] = useState('');
  const busy = requeue.isPending || resolve.isPending;
  return (
    <Card data-testid="admin-publish-monitor-stuck" style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <TriangleAlert className="h-5 w-5" style={{ color: 'var(--warning)' }} />外部待处理
        </CardTitle>
        <CardDescription style={muted}>
          Post for Me 的删除、断开或清理连续失败 50 次后停止自动重试。先到 Post for Me 后台按账号编号查看。
          还没处理好、想让系统再试：点“重新排队”。已经确认那个账号在 Post for Me 里不存在了：点“已手动处理，结束”，
          系统不会再重试（Post for Me 对不存在的账号返回的是出错，不是“找不到”，单靠重新排队结束不了）。
          连接请求的清理停下后，每日孤儿清扫仍会兜底。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm" style={{ color: 'var(--text-primary)' }}>
        {stuck.isLoading ? <p style={muted}>正在读取…</p> : !stuck.data ? (
          <div className="space-y-2">
            <p role="alert" style={{ color: 'var(--color-destructive)' }}>暂时读不到，请稍后再试。</p>
            <Button variant="outline" onClick={() => void stuck.refetch()}>重新读取</Button>
          </div>
        ) : stuck.data.totals.connections + stuck.data.totals.requests === 0 ? <p style={muted}>没有待处理的记录。</p> : (
          <>
            <p data-testid="stuck-totals">共 {stuck.data.totals.connections} 条账号清理、{stuck.data.totals.requests} 条连接请求清理
              {stuck.data.totals.connections > stuck.data.connections.length
                || stuck.data.totals.requests > stuck.data.requests.length ? '；下面只列出最早的一部分，处理后刷新会继续出现其余的' : ''}。</p>
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
                    <td className="py-1"><span className="flex gap-1">
                      <Button size="sm" variant="outline" disabled={busy}
                        onClick={() => requeue.mutate({ kind: 'connection', id: c.id })}>重新排队</Button>
                      {confirming === c.id ? (
                        <Button size="sm" variant="destructive" disabled={busy} onClick={() => {
                          setConfirming(''); resolve.mutate({ kind: 'connection', id: c.id });
                        }}>确认已在 Post for Me 处理，结束</Button>
                      ) : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(c.id)}>已手动处理，结束</Button>}
                    </span></td>
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
                    <td className="py-1"><span className="flex gap-1">
                      <Button size="sm" variant="outline" disabled={busy}
                        onClick={() => requeue.mutate({ kind: 'request', id: r.id })}>重新排队</Button>
                      {confirming === r.id ? (
                        <Button size="sm" variant="destructive" disabled={busy} onClick={() => {
                          setConfirming(''); resolve.mutate({ kind: 'request', id: r.id });
                        }}>确认已在 Post for Me 处理，结束</Button>
                      ) : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(r.id)}>已手动处理，结束</Button>}
                    </span></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </>
        )}
        {requeue.data && <p role="status">{requeue.data.requeued ? '已重新排队，下一次定时任务会再试。' : '这条记录已经不需要处理了。'}</p>}
        {resolve.data && <p role="status">{resolve.data.resolved ? '已结束这条记录。' : '这条记录已经不需要处理了。'}</p>}
        {(requeue.error ?? resolve.error) && <p role="alert" style={{ color: 'var(--color-destructive)' }}>操作没有成功，请稍后再试。</p>}
      </CardContent>
    </Card>
  );
}
