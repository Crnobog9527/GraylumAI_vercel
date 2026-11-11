'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState, type CSSProperties } from 'react';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/trpc/client';
import type { BrandAccount } from './brands';
import styles from './data-review.module.css';
import { StateBlock } from './StateBlock';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import {
  POSTED_AT_SOURCE, SOURCE_LABEL, dataErrorMessage, errorCode, formatDay, metricCell, metricColumns, metricLabel,
  platformName,
} from './labels';

type Snapshot = { capturedOn: string; metrics: Record<string, number>; missingFields: string[] };
export type Post = { id: string; connectionId: string; source: 'postforme' | 'tikhub' | 'manual'; url: string | null;
  postedAt: string | null; postedAtSource: 'provider' | 'x_snowflake' | 'user' | null; firstSeenAt: string;
  titleExcerpt: string | null; workItemId: string | null; latest: (Snapshot & { breakdowns?: unknown }) | null };
export type PostConnection = { id: string; platform: string };

const MISSING = new Set(['未取到', '平台不提供']);

/**
 * PUBLISH-MONITOR PR-7 (plan §9 items 2, 4): the user's own posts inside the plan's window with their latest numbers.
 * Metrics are cumulative as of the last read; a missing field says why instead of showing 0. Each post opens its daily
 * snapshots, recorded from the day the account was connected (Post for Me keeps no history).
 * One list serves every width: a table-like row per post on a desktop, a card per post on a phone (data-review.module.css).
 */
export function PostsPanel({ windowDays, posts, connections, accountOf, onLinked, onOpenTab }: { windowDays: number; posts: Post[];
  connections: PostConnection[]; accountOf: (connectionId: string) => BrandAccount | undefined; onLinked: () => void;
  onOpenTab?: (tab: 'accounts' | 'import') => void }) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const shown = filter ? posts.filter(p => p.connectionId === filter) : posts;
  const columns = metricColumns(shown.map(p => p.latest));
  const platformOf = new Map(connections.map(c => [c.id, c.platform]));
  return (
    <section aria-labelledby="pm-posts">
      <div className={styles.sectionHead}>
        <h2 id="pm-posts">作品数据（近 {windowDays} 天）</h2>
        {connections.length > 1 && (
          <select aria-label="按账号筛选" className={styles.select} value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="">全部账号</option>
            {connections.map(c => <option key={c.id} value={c.id}>
              {platformName(c.platform)} · {accountOf(c.id)?.label ?? ''}</option>)}
          </select>
        )}
      </div>
      <p className={styles.lead}>数字是读取时的累计值。每天的变化从连接那天开始记录，连接之前的变化无法补回。</p>
      {shown.length === 0 ? (
        <StateBlock icon={<FileText size={20} aria-hidden />} title="这个时间范围里还没有读到作品"
          text="刚连接的账号要等第一次读取完成；读不到时会在账号上标出原因。">
          {onOpenTab && <>
            <button type="button" className={styles.button} onClick={() => onOpenTab('accounts')}>看账号状态</button>
            <button type="button" className={styles.buttonQuiet} onClick={() => onOpenTab('import')}>用表格导入</button>
          </>}
        </StateBlock>
      ) : (
        <div className={styles.postsScroll}>
          <ul className={styles.posts} style={{ '--pm-metrics': columns.length } as CSSProperties}>
            {/* The column names of the desktop layout; every number below also carries its own label for a phone and a reader. */}
            <li className={styles.postsHead} aria-hidden="true">
              <span>作品</span><span>发布日期</span>
              {columns.map(key => <span key={key}>{metricLabel(key)}</span>)}
              <span />
            </li>
            {shown.map(post => (
              <li key={post.id} className={styles.post}>
                <div className={styles.postRow}>
                  <div className={styles.postTitle}>
                    {post.url ? <a href={post.url} target="_blank" rel="noreferrer noopener">
                      {post.titleExcerpt || '（没有标题）'}</a> : post.titleExcerpt || '（没有标题）'}
                    <small>{platformName(platformOf.get(post.connectionId) ?? '')} · {SOURCE_LABEL[post.source]}</small>
                  </div>
                  <div className={styles.postDate}>{formatDay(post.postedAt)}
                    <small>{post.postedAtSource ? POSTED_AT_SOURCE[post.postedAtSource] : ''}</small></div>
                  <dl className={styles.metrics}>
                    {columns.map(key => {
                      const value = metricCell(key, post.latest);
                      return (
                        <div key={key} className={styles.metric}>
                          <dt>{metricLabel(key)}</dt>
                          <dd data-missing={MISSING.has(value)}>{value}</dd>
                        </div>
                      );
                    })}
                  </dl>
                  <Button className={styles.postMore} size="sm" variant="ghost" aria-expanded={open === post.id}
                    onClick={() => setOpen(open === post.id ? null : post.id)}>{open === post.id ? '收起' : '每天变化'}</Button>
                </div>
                {open === post.id && (
                  <div className={styles.postDetail}>
                    <PostHistory postId={post.id} />
                    <LinkItem post={post} account={accountOf(post.connectionId)} onLinked={onLinked} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PostHistory({ postId }: { postId: string }) {
  const history = trpc.publishMonitor.postHistory.useQuery({ postId }, { retry: false });
  if (history.isPending) return <PageSkeleton compact rows={2} label="发布记录读取中" />;
  if (history.error || !history.data) {
    return <p role="alert" className={styles.error}>{dataErrorMessage(errorCode(history.error))}</p>;
  }
  const snapshots = history.data.snapshots;
  if (snapshots.length === 0) return <p className={styles.hint}>还没有按天的记录。</p>;
  const columns = metricColumns(snapshots);
  return (
    <div className={styles.miniTableWrap}>
      <table className={styles.miniTable} aria-label="每天的数字">
        <thead><tr><th>日期</th><th>来源</th>
          {columns.map(key => <th key={key}>{metricLabel(key)}</th>)}</tr></thead>
        <tbody>
          {snapshots.map(s => (
            <tr key={s.capturedOn + s.source}><td>{s.capturedOn}</td><td>{SOURCE_LABEL[s.source]}</td>
              {columns.map(key => <td key={key}>{metricCell(key, s)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Links a post to one of this brand account's content items, so a review can say which plan it came from. */
function LinkItem({ post, account, onLinked }: { post: Post; account: BrandAccount | undefined; onLinked: () => void }) {
  const link = trpc.publishMonitor.linkPost.useMutation();
  if (!account || account.items.length === 0) return null;
  return (
    <label className={styles.inlineField}>
      <span>对应的内容</span>
      <select className={styles.select} value={post.workItemId ?? ''} disabled={link.isPending}
        onChange={event => link.mutate({ postId: post.id, workItemId: event.target.value || null }, { onSuccess: onLinked })}>
        <option value="">不关联</option>
        {account.items.map(item => <option key={item.workItemId} value={item.workItemId}>{item.title}</option>)}
      </select>
      {link.error && <span role="alert" className={styles.error}>{dataErrorMessage(errorCode(link.error))}</span>}
    </label>
  );
}
