/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { RATE_KEYS } from '@repo/api/src/services/publishMonitor/rateKeys';

/**
 * PUBLISH-MONITOR RC: the form of the single-post diagnosis. The user types what the platform's back office shows (percentages as the
 * platform writes them, seconds as seconds); this turns the text into the fractions the server stores. A blank field is simply left out,
 * never zero. Every number is checked here so the user sees the problem next to the field, and again by the server and the database.
 */
export type RateKey = (typeof RATE_KEYS)[number];
/** Shown in this order; the first group is what a short video's funnel is judged on. */
export const RATE_FIELDS: ReadonlyArray<{ key: RateKey; label: string; unit: '%' | '秒' }> = [
  { key: 'bounce_2s', label: '2 秒跳出率', unit: '%' }, { key: 'retain_3s', label: '3 秒完播率（留存）', unit: '%' },
  { key: 'retain_5s', label: '5 秒完播率（留存）', unit: '%' }, { key: 'retain_30s', label: '30 秒留存', unit: '%' },
  { key: 'complete_rate', label: '完播率', unit: '%' }, { key: 'avg_watch_seconds', label: '平均观看时长', unit: '秒' },
  { key: 'avg_watch_pct', label: '平均观看占比', unit: '%' }, { key: 'like_rate', label: '点赞率', unit: '%' },
  { key: 'comment_rate', label: '评论率', unit: '%' }, { key: 'save_rate', label: '收藏率', unit: '%' },
  { key: 'share_rate', label: '转发率', unit: '%' }, { key: 'follow_rate', label: '关注率', unit: '%' },
  { key: 'profile_visit_rate', label: '主页访问率', unit: '%' }, { key: 'impressions_ctr', label: '曝光点击率', unit: '%' },
];

export type DiagnosticForm = { postId: string; rates: Partial<Record<RateKey, string>>; videoSeconds: string; dropSecond: string;
  openingText: string };
export type FormProblem = 'POST' | 'EMPTY' | 'RATE' | 'VIDEO' | 'DROP' | 'DROP_AFTER_END' | 'OPENING';
export const PROBLEM_TEXT: Record<FormProblem, string> = {
  POST: '请先选一条作品。', EMPTY: '至少填一项数据。', RATE: '有的数据读不出来或超出范围（百分比填 0 到 100）。',
  VIDEO: '视频时长要填 1 到 86400 之间的整数秒。', DROP: '流失的那一秒要填 0 到 86400 之间的整数。',
  DROP_AFTER_END: '流失的那一秒不能晚于视频结束。', OPENING: '开头文案最多 2000 字。',
};

const NUMBER = /^\d+(?:\.\d+)?$/;
/** "42", "42.5", "42%", "42.5 %" → 0.425; anything else is not a number. */
function parseValue(text: string, unit: '%' | '秒'): number | null {
  const cleaned = text.trim().replace(/[%％秒s]\s*$/i, '').trim();
  if (!NUMBER.test(cleaned)) return null;
  const value = Number(cleaned);
  if (unit === '%') return value > 100 ? null : Math.round(value * 100) / 10_000;
  return value > 86_400 ? null : Math.round(value * 100) / 100;
}
const wholeSeconds = (text: string, min: number): number | null | 'bad' => {
  const cleaned = text.trim();
  if (cleaned === '') return null;
  return /^\d{1,6}$/.test(cleaned) && Number(cleaned) >= min && Number(cleaned) <= 86_400 ? Number(cleaned) : 'bad';
};

export function buildDiagnostic(form: DiagnosticForm):
  { ok: true; input: { postId: string; rates: Partial<Record<RateKey, number>>; openingText: string | null; videoSeconds: number | null;
    dropSecond: number | null } } | { ok: false; problems: FormProblem[] } {
  const problems = new Set<FormProblem>();
  if (!form.postId) problems.add('POST');
  const rates: Partial<Record<RateKey, number>> = {};
  for (const field of RATE_FIELDS) {
    const text = form.rates[field.key]?.trim() ?? '';
    if (text === '') continue;
    const value = parseValue(text, field.unit);
    if (value === null) problems.add('RATE'); else rates[field.key] = value;
  }
  if (problems.size === 0 && Object.keys(rates).length === 0) problems.add('EMPTY');
  const video = wholeSeconds(form.videoSeconds, 1), drop = wholeSeconds(form.dropSecond, 0);
  if (video === 'bad') problems.add('VIDEO');
  if (drop === 'bad') problems.add('DROP');
  if (typeof video === 'number' && typeof drop === 'number' && drop > video) problems.add('DROP_AFTER_END');
  const opening = form.openingText.trim();
  if ([...opening].length > 2000) problems.add('OPENING');
  if (problems.size) return { ok: false, problems: [...problems] };
  return { ok: true, input: { postId: form.postId, rates, openingText: opening === '' ? null : opening,
    videoSeconds: video as number | null, dropSecond: drop as number | null } };
}

/** How a stored rate reads back to the user: a fraction as a percentage, seconds as seconds. */
export function showRate(key: RateKey, value: number): string {
  const field = RATE_FIELDS.find(f => f.key === key);
  return field?.unit === '秒' ? `${value} 秒` : `${Math.round(value * 10_000) / 100}%`;
}
export const rateLabel = (key: string) => RATE_FIELDS.find(f => f.key === key)?.label ?? '其他指标';
