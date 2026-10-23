'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Fragment, useState } from 'react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/trpc/client';
import type { BrandAccount } from './brands';
import {
  POSTED_AT_SOURCE, SOURCE_LABEL, dataErrorMessage, errorCode, formatDay, metricCell, metricColumns, metricLabel,
  platformName,
} from './labels';

type Snapshot = { capturedOn: string; metrics: Record<string, number>; missingFields: string[] };
export type Post = { id: string; connectionId: string; source: 'postforme' | 'tikhub' | 'manual'; url: string | null;
  postedAt: string | null; postedAtSource: 'provider' | 'x_snowflake' | 'user' | null; firstSeenAt: string;
  titleExcerpt: string | null; workItemId: string | null; latest: (Snapshot & { breakdowns?: unknown }) | null };
export type PostConnection = { id: string; platform: string };

/**
 * PUBLISH-MONITOR PR-7 (plan §9 items 2, 4): the user's own posts inside the plan's window with their latest numbers.
 * Metrics are cumulative as of the last read; a missing field says why instead of showing 0. Each post opens its daily
 * snapshots, recorded from the day the account was connected (Post for Me keeps no history).
 */
export function PostsPanel({ windowDays, posts, connections, accountOf, onLinked }: { windowDays: number; posts: Post[];
  connections: PostConnection[]; accountOf: (connectionId: string) => BrandAccount | undefined; onLinked: () => void }) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const shown = filter ? posts.filter(p => p.connectionId === filter) : posts;
  const columns = metricColumns(shown.map(p => p.latest));
  const platformOf = new Map(connections.map(c => [c.id, c.platform]));
  return (
    <section className="space-y-3" aria-labelledby="pm-posts">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pm-posts" className="text-base font-semibold">作品数据（近 {windowDays} 天）</h2>
        {connections.length > 1 && (
          <select aria-label="按账号筛选" className="rounded-md border px-2 py-1.5 text-sm" style={{ borderColor: 'var(--border-primary)' }}
            value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="">全部账号</option>
            {connections.map(c => <option key={c.id} value={c.id}>
              {platformName(c.platform)} · {accountOf(c.id)?.label ?? ''}</option>)}
          </select>
        )}
      </div>
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        数字是读取时的累计值。每天的变化从连接那天开始记录，连接之前的变化无法补回。</p>
      {shown.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          这个时间范围里还没有读到作品。刚连接的账号要等第一次读取完成；读不到时会在账号上标出原因。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead><tr style={{ color: 'var(--text-tertiary)' }}>
              <th className="py-1.5 pr-3 font-medium">作品</th><th className="py-1.5 pr-3 font-medium">发布日期</th>
              {columns.map(key => <th key={key} className="py-1.5 pr-3 font-medium">{metricLabel(key)}</th>)}
              <th className="py-1.5 font-medium"><span className="sr-only">操作</span></th>
            </tr></thead>
            <tbody>
              {shown.map(post => (
                <Fragment key={post.id}>
                  <tr className="border-t align-top" style={{ borderColor: 'var(--border-primary)' }}>
                    <td className="max-w-[280px] py-2 pr-3">
                      {post.url ? <a className="underline" href={post.url} target="_blank" rel="noreferrer noopener">
                        {post.titleExcerpt || '（没有标题）'}</a> : post.titleExcerpt || '（没有标题）'}
                      <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {platformName(platformOf.get(post.connectionId) ?? '')} · {SOURCE_LABEL[post.source]}</div>
                    </td>
                    <td className="py-2 pr-3">{formatDay(post.postedAt)}
                      <span className="text-xs">{post.postedAtSource ? POSTED_AT_SOURCE[post.postedAtSource] : ''}</span></td>
                    {columns.map(key => <td key={key} className="py-2 pr-3">{metricCell(key, post.latest)}</td>)}
                    <td className="py-2">
                      <Button size="sm" variant="ghost" aria-expanded={open === post.id}
                        onClick={() => setOpen(open === post.id ? null : post.id)}>{open === post.id ? '收起' : '每天变化'}</Button>
                    </td>
                  </tr>
                  {open === post.id && (
                    <tr><td colSpan={columns.length + 3} className="pb-3">
                      <PostHistory postId={post.id} />
                      <LinkItem post={post} account={accountOf(post.connectionId)} onLinked={onLinked} />
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PostHistory({ postId }: { postId: string }) {
  const history = trpc.publishMonitor.postHistory.useQuery({ postId }, { retry: false });
  if (history.isPending) return <p className="text-sm">正在读取…</p>;
  if (history.error || !history.data) {
    return <p role="alert" className="text-sm" style={{ color: 'var(--color-error)' }}>{dataErrorMessage(errorCode(history.error))}</p>;
  }
  const snapshots = history.data.snapshots;
  if (snapshots.length === 0) return <p className="text-sm">还没有按天的记录。</p>;
  const columns = metricColumns(snapshots);
  return (
    <table className="my-2 w-full text-left text-xs" aria-label="每天的数字">
      <thead><tr><th className="pr-3 font-medium">日期</th><th className="pr-3 font-medium">来源</th>
        {columns.map(key => <th key={key} className="pr-3 font-medium">{metricLabel(key)}</th>)}</tr></thead>
      <tbody>
        {snapshots.map(s => (
          <tr key={s.capturedOn + s.source}><td className="pr-3">{s.capturedOn}</td><td className="pr-3">{SOURCE_LABEL[s.source]}</td>
            {columns.map(key => <td key={key} className="pr-3">{metricCell(key, s)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

/** Links a post to one of this brand account's content items, so a review can say which plan it came from. */
function LinkItem({ post, account, onLinked }: { post: Post; account: BrandAccount | undefined; onLinked: () => void }) {
  const link = trpc.publishMonitor.linkPost.useMutation();
  if (!account || account.items.length === 0) return null;
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span>对应的内容</span>
      <select className="rounded-md border px-2 py-1" style={{ borderColor: 'var(--border-primary)' }}
        value={post.workItemId ?? ''} disabled={link.isPending}
        onChange={event => link.mutate({ postId: post.id, workItemId: event.target.value || null }, { onSuccess: onLinked })}>
        <option value="">不关联</option>
        {account.items.map(item => <option key={item.workItemId} value={item.workItemId}>{item.title}</option>)}
      </select>
      {link.error && <span role="alert" style={{ color: 'var(--color-error)' }}>{dataErrorMessage(errorCode(link.error))}</span>}
    </label>
  );
}
