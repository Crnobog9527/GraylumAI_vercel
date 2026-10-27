'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { trpc } from '@/trpc/client';
import { dataErrorMessage, errorCode, formatDay, formatMetric, metricLabel } from './labels';

/**
 * PUBLISH-MONITOR PR-7 (plan §5): the weekly reviews and, for Gold, the automatic weekly review switch. The written
 * part is the model's; the numbers come only from the stored host table (`tables`), never parsed from the text.
 */
export type Review = { id: string; periodStart: string; status: 'claimed' | 'completed' | 'skipped'; body: string | null;
  tables: unknown; notice: string | null; skipReason?: string | null };

type Row = { postId: string; title: string; ageDays: number; status: 'available' | 'too_new' | 'insufficient_samples';
  comparisons: Record<string, { value: number; median: number; samples: number; relative: 'above' | 'below' | 'same' }> };
type Week = { start: string; end: string; published: number; matched_posts: number; status: string };
const RELATIVE = { above: '高于', below: '低于', same: '持平' } as const;
const STATUS = { too_new: '太新，下周再看', insufficient_samples: '样本不足' } as const;

/** Only the shapes the page can show safely; anything else in the stored table is ignored, never guessed. */
export function reviewTable(tables: unknown): { rows: Row[]; weeks: Week[] } {
  const t = tables && typeof tables === 'object' ? tables as { rows?: unknown; weekly?: unknown } : {};
  const rows = Array.isArray(t.rows) ? t.rows.filter((r): r is Row => !!r && typeof r === 'object'
    && typeof (r as Row).postId === 'string' && typeof (r as Row).ageDays === 'number') : [];
  const weeks = Array.isArray(t.weekly) ? t.weekly.filter((w): w is Week => !!w && typeof w === 'object'
    && typeof (w as Week).start === 'string' && typeof (w as Week).published === 'number') : [];
  return { rows, weeks };
}

export function ReviewPanel({ gold }: { gold: boolean }) {
  // The weekly review has its own admin switch; while it is off the server answers 403, so do not ask at all.
  const features = trpc.publishMonitor.features.useQuery(undefined, { retry: false, staleTime: 300_000 });
  const open = features.data?.weeklyReview === true;
  const reviews = trpc.publishMonitor.review.list.useQuery(undefined, { retry: false, enabled: open });
  return (
    <section className="space-y-4" aria-labelledby="pm-review">
      <h2 id="pm-review" className="text-base font-semibold">每周复盘</h2>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        想现在就复盘，可以在<Link className="underline" href="/app/positioning">对话</Link>里说“帮我复盘最近的作品”，按对话正常扣积分。</p>
      {gold && <AutoReviewSwitch />}
      {features.isPending ? <p className="text-sm">正在读取…</p>
        : !open ? <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>每周复盘还没有开放。</p>
        : reviews.isPending ? <p className="text-sm">正在读取…</p>
        : reviews.error ? <p role="alert" className="text-sm">{dataErrorMessage(errorCode(reviews.error))}</p>
          : (reviews.data as Review[]).length === 0 ? <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            还没有复盘。{gold ? '自动复盘在打开满 7 天后生成第一份。' : ''}</p>
            : (reviews.data as Review[]).map(review => <ReviewCard key={review.id} review={review} />)}
    </section>
  );
}

function AutoReviewSwitch() {
  const settings = trpc.publishMonitor.settings.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const save = trpc.publishMonitor.setAutoReview.useMutation({ onSuccess: () => utils.publishMonitor.settings.invalidate() });
  if (!settings.data) return null;
  const on = settings.data.autoReviewEnabled;
  return (
    <div className="space-y-1 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--border-primary)' }}>
      <label className="flex items-center gap-2">
        <Switch checked={on} disabled={save.isPending} onCheckedChange={enabled => save.mutate({ enabled })} aria-label="每周自动复盘" />
        每周自动复盘
      </label>
      <p style={{ color: 'var(--text-secondary)' }}>
        {on ? `已打开${settings.data.autoReviewEnabledAt ? `（${formatDay(settings.data.autoReviewEnabledAt)} 起）` : ''}，`
          + '满 7 天生成一份，之后每 7 天一份。' : '已关闭，不会自动复盘，也不会扣积分。'}
        每次按实际用量扣积分，有花费上限；复盘前积分不够就跳过这一周。关掉再打开，会重新等满 7 天。</p>
      {save.error && <p role="alert" style={{ color: 'var(--color-error)' }}>{dataErrorMessage(errorCode(save.error))}</p>}
    </div>
  );
}

function ReviewCard({ review }: { review: Review }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const utils = trpc.useUtils();
  const { rows, weeks } = reviewTable(review.tables);
  async function download() {
    setBusy(true); setError('');
    try {
      const file = await utils.publishMonitor.review.export.fetch({ id: review.id });
      const url = URL.createObjectURL(new Blob([file.content], { type: file.mediaType }));
      const a = document.createElement('a');
      a.href = url; a.download = file.filename; a.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(dataErrorMessage(errorCode(cause))); } finally { setBusy(false); }
  }
  return (
    <article className="space-y-3 rounded-lg border p-4" style={{ borderColor: 'var(--border-primary)' }}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{formatDay(review.periodStart)} 这一周</h3>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {review.notice ?? (review.status === 'claimed' ? '正在生成…' : review.status === 'skipped' ? '这一周没有复盘' : '')}</span>
      </header>
      {review.body && <MessageMarkdown text={review.body} />}
      {weeks.length > 0 && (
        <ul className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {weeks.map(w => <li key={w.start}>{w.start} 至 {w.end}：发布 {w.published} 条
            {w.status === 'data_accumulating' ? '，互动变化数据积累中' : `，${w.matched_posts} 条有前后两天的记录`}</li>)}
        </ul>
      )}
      {rows.length > 0 && <AgeTable rows={rows} />}
      {review.status === 'completed' && review.body && (
        <Button size="sm" variant="outline" disabled={busy} onClick={download}>导出</Button>
      )}
      {error && <p role="alert" className="text-sm" style={{ color: 'var(--color-error)' }}>{error}</p>}
    </article>
  );
}

/** Each post at day 1, 3 and 7 after publishing, against the same account's median at that age (plan §5.2 item 1). */
function AgeTable({ rows }: { rows: Row[] }) {
  const posts = [...new Map(rows.map(r => [r.postId, r.title])).entries()];
  const cell = (postId: string, age: number) => {
    const row = rows.find(r => r.postId === postId && r.ageDays === age);
    if (!row) return '—';
    if (row.status !== 'available') return STATUS[row.status];
    return Object.entries(row.comparisons).map(([metric, c]) =>
      `${metricLabel(metric)} ${formatMetric(metric, c.value)}（${RELATIVE[c.relative]}中位数 ${formatMetric(metric, c.median)}）`).join('；');
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-xs" aria-label="按发布天数对比">
        <thead><tr><th className="pr-3 font-medium">作品</th>
          {[1, 3, 7].map(age => <th key={age} className="pr-3 font-medium">发布后第 {age} 天</th>)}</tr></thead>
        <tbody>
          {posts.map(([postId, title]) => (
            <tr key={postId} className="border-t align-top" style={{ borderColor: 'var(--border-primary)' }}>
              <td className="max-w-[200px] py-1 pr-3">{title || '（没有标题）'}</td>
              {[1, 3, 7].map(age => <td key={age} className="py-1 pr-3">{cell(postId, age)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
