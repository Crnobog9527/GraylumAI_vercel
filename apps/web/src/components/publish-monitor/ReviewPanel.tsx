'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, NotebookText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { trpc } from '@/trpc/client';
import { dataErrorMessage, errorCode, formatDay, formatMetric, metricLabel } from './labels';
import { coachTable, CoachTables, EMPTY_COACH, type CoachTable } from './CoachTables';
import { PillarSettings } from './PillarSettings';
import styles from './data-review.module.css';
import { StateBlock } from './StateBlock';

/**
 * PUBLISH-MONITOR PR-7 (plan §5): the weekly reviews and, for Gold, the automatic weekly review switch. The written
 * part is the model's; the numbers come only from the stored host table (`tables`), never parsed from the text.
 */
export type Review = { id: string; periodStart: string; status: 'claimed' | 'completed' | 'skipped'; body: string | null;
  tables: unknown; notice: string | null; skipReason?: string | null;
  /** Brand coach reviews: which rhythm and which brand (absent or weekly without a brand: the plain weekly review). */
  cadence?: string; businessName?: string | null };

type Row = { postId: string; title: string; ageDays: number; status: 'available' | 'too_new' | 'insufficient_samples';
  comparisons: Record<string, { value: number; median: number; samples: number; relative: 'above' | 'below' | 'same' }> };
type Week = { start: string; end: string; published: number; matched_posts: number; status: string };
const RELATIVE = { above: '高于', below: '低于', same: '持平' } as const;
/** The title of a review by its rhythm; anything unknown reads as the weekly one. */
const PERIOD_TITLE: Record<string, string> = { weekly: '这一周', monthly: '月度复盘', quarterly: '季度体检', chat: '对话里的复盘' };
export const reviewTitle = (review: Pick<Review, 'periodStart' | 'cadence' | 'businessName'>) => {
  const period = PERIOD_TITLE[review.cadence ?? 'weekly'] ?? PERIOD_TITLE.weekly;
  return `${review.businessName ? `${review.businessName} · ` : ''}${formatDay(review.periodStart)} ${period}`;
};
const STATUS = { too_new: '太新，下周再看', insufficient_samples: '样本不足' } as const;

/** Only the shapes the page can show safely; anything else in the stored table is ignored, never guessed. */
export function reviewTable(tables: unknown): { rows: Row[]; weeks: Week[]; coach: CoachTable } {
  const t = tables && typeof tables === 'object' ? tables as { rows?: unknown; weekly?: unknown } : {};
  const rows = Array.isArray(t.rows) ? t.rows.filter((r): r is Row => !!r && typeof r === 'object'
    && typeof (r as Row).postId === 'string' && typeof (r as Row).ageDays === 'number') : [];
  const weeks = Array.isArray(t.weekly) ? t.weekly.filter((w): w is Week => !!w && typeof w === 'object'
    && typeof (w as Week).start === 'string' && typeof (w as Week).published === 'number') : [];
  return { rows, weeks, coach: coachTable(tables) };
}

/** The review opened when the tab is shown: the latest one that has something to read, whatever order the list came in. */
export function latestReadable(reviews: Review[]): string | null {
  return reviews.filter(review => review.body).reduce<Review | null>(
    (best, review) => (!best || review.periodStart > best.periodStart ? review : best), null)?.id ?? null;
}

export function ReviewPanel({ gold }: { gold: boolean }) {
  // The weekly review has its own admin switch; while it is off the server answers 403, so do not ask at all.
  const features = trpc.publishMonitor.features.useQuery(undefined, { retry: false, staleTime: 300_000 });
  const open = features.data?.weeklyReview === true;
  const reviews = trpc.publishMonitor.review.list.useQuery(undefined, { retry: false, enabled: open });
  const list = (reviews.data ?? []) as Review[];
  // Below 1360px the settings fold away above the reviews (closed until the user opens them); a wider screen always
  // shows them beside the reviews, whatever this says (data-review.module.css).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const shown = picked === undefined ? latestReadable(list) : picked;
  const hasSettings = gold || open;
  return (
    <section aria-labelledby="pm-review">
      <h2 id="pm-review" className={styles.srOnly}>每周复盘</h2>
      <p className={styles.lead}>
        想现在就复盘，可以在<Link href="/app/positioning">对话</Link>里说“帮我复盘最近的作品”，按对话正常扣积分。</p>
      <div className={styles.reviewLayout} data-settings={hasSettings}>
        <div className={styles.reviewMain}>
          {features.isPending ? <ReviewSkeleton />
            : !open ? <StateBlock icon={<NotebookText size={20} aria-hidden />} title="还没有开放" text="每周复盘还没有开放。" />
            : reviews.isPending ? <ReviewSkeleton />
            : reviews.error ? <StateBlock tone="error" title="暂时读不到复盘" text={dataErrorMessage(errorCode(reviews.error))} />
              : list.length === 0 ? (
                <StateBlock icon={<NotebookText size={20} aria-hidden />} title="还没有复盘"
                  text={`还没有复盘。${gold ? '自动复盘在打开满 7 天后生成第一份。' : ''}`}>
                  <Link className={styles.button} href="/app/positioning">去对话里复盘</Link>
                </StateBlock>
              ) : list.map(review => <ReviewCard key={review.id} review={review} expanded={review.id === shown}
                onToggle={() => setPicked(review.id === shown ? null : review.id)} />)}
        </div>
        {hasSettings && (
          <aside className={styles.reviewSide} aria-labelledby="pm-review-settings" data-open={settingsOpen}>
            <h3 id="pm-review-settings" className={styles.reviewSideTitle}>
              <button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>
                复盘设置<ChevronDown size={16} aria-hidden /></button>
              <span>复盘设置</span>
            </h3>
            <div className={styles.reviewSideBody}>
              {gold && <AutoReviewSwitch />}
              {open && <PillarSettings />}
            </div>
          </aside>
        )}
      </div>
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
    <div className={`${styles.card} ${styles.cardStack}`}>
      <label className={styles.switchRow}>
        <Switch checked={on} disabled={save.isPending} onCheckedChange={enabled => save.mutate({ enabled })} aria-label="每周自动复盘" />
        每周自动复盘
      </label>
      <p className={styles.hint}>
        {on ? `已打开${settings.data.autoReviewEnabledAt ? `（${formatDay(settings.data.autoReviewEnabledAt)} 起）` : ''}，`
          + '满 7 天生成一份，之后每 7 天一份。' : '已关闭，不会自动复盘，也不会扣积分。'}
        每次按实际用量扣积分，有花费上限；复盘前积分不够就跳过这一周。关掉再打开，会重新等满 7 天。</p>
      {save.error && <p role="alert" className={styles.error}>{dataErrorMessage(errorCode(save.error))}</p>}
    </div>
  );
}

/**
 * One review. Only the opened one draws its text and tables (a review is long, and a year holds up to 52); the others
 * are their title and state, one click away. A week that was skipped or is still being written has nothing to open.
 */
function ReviewCard({ review, expanded, onToggle }: { review: Review; expanded: boolean; onToggle: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const utils = trpc.useUtils();
  const readable = Boolean(review.body);
  const state = review.notice ?? (review.status === 'claimed' ? '正在生成…' : review.status === 'skipped' ? '这一周没有复盘' : '');
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
    <article className={styles.review} data-open={readable && expanded}>
      <header className={styles.reviewHead}>
        <h3>{readable ? (
          <button type="button" aria-expanded={expanded} onClick={onToggle}>
            {reviewTitle(review)}<ChevronDown size={16} aria-hidden /></button>
        ) : reviewTitle(review)}</h3>
        {state && <span>{state}</span>}
      </header>
      {readable && expanded && <ReviewBody review={review} busy={busy} onDownload={download} />}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </article>
  );
}

function ReviewBody({ review, busy, onDownload }: { review: Review; busy: boolean; onDownload: () => void }) {
  const { rows, weeks, coach } = reviewTable(review.tables);
  return (
    <div className={styles.reviewBody}>
      <div className={styles.reviewText}><MessageMarkdown text={review.body!} /></div>
      <div className={styles.reviewData}>
        {weeks.length > 0 && (
          <ul className={styles.reviewWeeks}>
            {weeks.map(w => <li key={w.start}>{w.start} 至 {w.end}：发布 {w.published} 条
              {w.status === 'data_accumulating' ? '，互动变化数据积累中' : `，${w.matched_posts} 条有前后两天的记录`}</li>)}
          </ul>
        )}
        {rows.length > 0 && <AgeTable rows={rows} />}
        {coach !== EMPTY_COACH && <CoachTables coach={coach} />}
      </div>
      {review.status === 'completed' && (
        <div className={styles.rowActions}>
          <Button size="sm" variant="outline" disabled={busy} onClick={onDownload}>导出</Button>
        </div>
      )}
    </div>
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

/** While the reviews are read: the card's shape, with no words or spinner (Owner: no "loading" text on pages). */
function ReviewSkeleton() {
  return (
    <div aria-busy="true" data-testid="review-skeleton" className={`${styles.review} ${styles.reviewWait}`}>
      {['40%', '100%', '84%', '66%'].map(width => <div key={width} className={styles.sk} style={{ width, height: 12 }} />)}
    </div>
  );
}
