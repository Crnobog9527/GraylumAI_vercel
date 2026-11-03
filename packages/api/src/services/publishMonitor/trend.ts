/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DAY_MS, engagementRate, isoDay, median, round, utcDay } from './coach/stats';
import { DataError } from './data';

/**
 * PUBLISH-MONITOR block A (Owner 2026-10-27): the weekly trend behind the "数据复盘" charts, per own connection (platforms are never
 * mixed). Weeks are the 7-day periods ending yesterday (UTC), as in the review pack. Views and engagement are the medians of the
 * posts' settled day-7 numbers by publish week; followers are the week's last account-level point; frequency counts posts
 * (missing for an empty week before the connection, which was not recorded).
 * Missing is null with a reason, never zero.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();
const metrics = z.record(z.string(), z.number());
const rowsSchema = z.object({
  windowDays: z.number().int().min(1),
  connections: z.array(z.object({ id: uuid, platform: z.string(), source: z.enum(['postforme', 'tikhub', 'manual']),
    businessId: uuid.nullable(), businessName: z.string().nullable(), connectedAt: z.string(),
    followers: z.array(z.object({ date: z.string(), value: z.number() })),
    posts: z.array(z.object({ postedAt: z.string(), day7: metrics.nullable() })) })),
});
type Rows = z.infer<typeof rowsSchema>;

/** Why a week has no number: before the connection (data is recorded from that day), or its posts are not 7 days old yet. */
export type WeekNote = 'before_connected' | 'too_new' | null;
export type TrendWeek = { start: string; end: string; posts: number | null; viewsMedian: number | null; viewsSamples: number;
  engagementMedian: number | null; followers: number | null; note: WeekNote };
/** not_provided: the platform does not give it; accumulating: nothing recorded yet. */
export type Gap = 'not_provided' | 'accumulating';
export type TrendSeries = { connectionId: string; platform: string; businessName: string | null; connectedOn: string;
  weeks: TrendWeek[]; gaps: Partial<Record<'followers' | 'views' | 'engagement', Gap>> };

function gapOf(values: Array<number | null>, settled: number, provided: boolean): Gap | undefined {
  if (values.some(v => v !== null)) return undefined;
  return !provided || settled > 0 ? 'not_provided' : 'accumulating';
}

export function trendSeries(rows: Rows, now: number): TrendSeries[] {
  const today = Math.floor(now / DAY_MS), last = today - 1;
  // Whole weeks inside the window only (Pro 30 days: 4, Gold 90 days: 12): a cut week would undercount its posts.
  const count = Math.max(1, Math.floor(rows.windowDays / 7));
  return rows.connections.map(c => {
    const connected = utcDay(c.connectedAt);
    const weeks: TrendWeek[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const end = last - 7 * i, start = end - 6;
      const inWeek = c.posts.filter(p => utcDay(p.postedAt) >= start && utcDay(p.postedAt) <= end);
      const views = inWeek.map(p => p.day7?.views).filter((v): v is number => v !== undefined);
      const rates = inWeek.map(p => engagementRate(p.day7)).filter((v): v is number => v !== null);
      const viewsMid = median(views), rateMid = median(rates);
      const followers = c.followers.filter(f => utcDay(f.date) >= start && utcDay(f.date) <= end).at(-1)?.value ?? null;
      const note: WeekNote = end < connected ? 'before_connected' : end > today - 8 && inWeek.length > 0 && views.length === 0 ? 'too_new' : null;
      // Before the connection an empty week is "not recorded", not "nothing posted": left missing, never drawn as 0.
      weeks.push({ start: isoDay(start), end: isoDay(end), posts: note === 'before_connected' && inWeek.length === 0 ? null : inWeek.length,
        viewsMedian: viewsMid === null ? null : Math.round(viewsMid), viewsSamples: views.length,
        engagementMedian: rateMid === null ? null : round(rateMid, 4), followers, note });
    }
    const settled = c.posts.filter(p => p.day7).length;
    const gaps: TrendSeries['gaps'] = {};
    const followers = gapOf(weeks.map(w => w.followers), c.followers.length, c.source !== 'postforme');
    const views = gapOf(weeks.map(w => w.viewsMedian), settled, true);
    const engagement = gapOf(weeks.map(w => w.engagementMedian), settled, true);
    if (followers) gaps.followers = followers;
    if (views) gaps.views = views;
    if (engagement) gaps.engagement = engagement;
    return { connectionId: c.id, platform: c.platform, businessName: c.businessName, connectedOn: isoDay(connected), weeks, gaps };
  });
}

export async function readTrend(db: Rpc, profileId: string, windowDays: number, now = Date.now()) {
  const result = await db.rpc('publish_monitor_trend_series', { a: uuid.parse(profileId), p_window_days: windowDays });
  if (result.error) {
    throw new DataError(result.error.message?.includes('PUBLISH_MONITOR_ACCOUNT_CLOSED') ? 'PUBLISH_MONITOR_ACCOUNT_CLOSED'
      : 'PUBLISH_MONITOR_UNAVAILABLE');
  }
  const parsed = rowsSchema.safeParse(result.data);
  if (!parsed.success) throw new DataError('PUBLISH_MONITOR_UNAVAILABLE');
  return { windowDays: parsed.data.windowDays, series: trendSeries(parsed.data, now) };
}
