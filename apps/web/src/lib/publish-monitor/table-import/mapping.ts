/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  MANUAL_METRICS, type ManualMetric, type ManualRow,
} from '@repo/api/src/services/publishMonitor/manualImport';
import type { Grid } from './table';

/**
 * PUBLISH-MONITOR PR-3b (plan §4.3): maps a platform export's columns onto Graylum's fields, suggests a mapping from
 * common Chinese and English header names, and turns the grid into rows for the user to confirm. A column the
 * suggestion does not recognise stays unmapped until the user picks a field; a cell that cannot be read is reported
 * for its row, never guessed. Blank cells stay absent, never zero.
 */
export type Field = 'postId' | 'url' | 'postedAt' | 'title' | ManualMetric;
export const FIELDS: readonly Field[] = ['postId', 'url', 'postedAt', 'title', ...MANUAL_METRICS];
/** Column index -> field; null = ignore this column. */
export type Mapping = Array<Field | null>;

const SYNONYMS: Record<Field, string[]> = {
  postId: ['作品id', '笔记id', '视频id', '内容id', 'postid', 'videoid', 'mediaid', 'id'],
  url: ['作品链接', '笔记链接', '视频链接', '链接', '地址', 'url', 'link', 'permalink', 'posturl'],
  postedAt: ['发布时间', '发布日期', '发表时间', '时间', '日期', 'publishtime', 'publishdate', 'posttime', 'date',
    'createdat', 'publishedat', 'postedat'],
  title: ['作品标题', '笔记标题', '视频标题', '标题', '作品名称', '描述', '文案', 'title', 'caption', 'description'],
  views: ['播放量', '播放', '观看量', '观看次数', '阅读量', '浏览量', 'views', 'videoviews', 'plays'],
  impressions: ['曝光量', '曝光', '展现量', '展示次数', 'impressions'],
  reach: ['覆盖人数', '触达人数', '覆盖', 'reach', 'accountsreached'],
  likes: ['点赞量', '点赞数', '点赞', '获赞', '喜欢', 'likes', 'reactions'],
  comments: ['评论量', '评论数', '评论', 'comments', 'replies'],
  shares: ['分享量', '分享数', '分享', '转发', 'shares', 'reposts', 'retweets'],
  saves: ['收藏量', '收藏数', '收藏', 'saves', 'saved', 'bookmarks'],
  followers_gained: ['涨粉', '新增粉丝', '粉丝增量', '净增粉丝', 'followersgained', 'newfollowers', 'follows',
    'subscribersgained'],
  profile_visits: ['主页访问', '主页访问量', '主页浏览', 'profilevisits', 'profileviews'],
  completion_rate: ['完播率', '完播', 'completionrate'],
};

const normalize = (header: string) => header.toLowerCase().replace(/[\s_\-()（）:：/.·]+/g, '');

/** Exact (normalised) synonym first, then a contained synonym; each field is suggested for one column at most. */
export function suggestMapping(header: string[]): Mapping {
  const mapping: Mapping = header.map(() => null);
  const taken = new Set<Field>();
  for (const exact of [true, false]) {
    header.forEach((name, column) => {
      if (mapping[column]) return;
      const key = normalize(name);
      if (!key) return;
      const field = FIELDS.find(f => !taken.has(f) && SYNONYMS[f].some(s => (exact ? key === s : s.length >= 2 && key.includes(s))));
      if (field) { mapping[column] = field; taken.add(field); }
    });
  }
  return mapping;
}

export type RowError = { line: number; code: 'POST_KEY_MISSING' | 'NUMBER_INVALID' | 'DATE_INVALID' | 'URL_INVALID'
  | 'METRICS_EMPTY'; column?: number };
export type BuiltRows = { rows: ManualRow[]; errors: RowError[]; duplicateFields: Field[] };

const UNITS: Record<string, number> = { 万: 1e4, w: 1e4, k: 1e3, m: 1e6, 亿: 1e8 };

/** "1,234", "1.2万", "3.4k", "45%" (completion rate only); blank or "-" is absent (undefined), unreadable is null. */
export function parseNumber(raw: string, percent: boolean): number | null | undefined {
  const text = raw.replace(/[\s,，]/g, '').toLowerCase();
  if (text === '' || text === '-' || text === '--' || text === '—') return undefined;
  const match = /^(\d+(?:\.\d+)?)(万|w|k|m|亿|%)?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (match[2] === '%') return percent ? value : null;
  const scaled = match[2] ? value * UNITS[match[2]]! : value;
  return Number.isFinite(scaled) ? Math.round(scaled * 100) / 100 : null;
}

/** ISO-like text, "2026/10/01 12:00", "2026年10月1日", or an Excel serial day (XLSX dates). */
export function parseDate(raw: string): string | null | undefined {
  const text = raw.trim();
  if (!text || text === '-') return undefined;
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    // Excel day 25569 is 1970-01-01; only plausible recent dates are accepted.
    return serial > 36526 && serial < 73051 ? new Date(Math.round((serial - 25569) * 86_400_000)).toISOString() : null;
  }
  const cn = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?$/.exec(text);
  const normalized = cn ? `${cn[1]}-${cn[2]!.padStart(2, '0')}-${cn[3]!.padStart(2, '0')}T${(cn[4] ?? '0').padStart(2, '0')}:${cn[5] ?? '00'}:00`
    : text.replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
      .replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}/.test(normalized) ? new Date(ms).toISOString() : null;
}

/**
 * Rows for the confirmation table. Lines are numbered as in the file (header = line 1). A row needs a post ID or a
 * link and at least one metric; anything unreadable is listed in `errors` and the row is left out.
 */
export function buildRows(grid: Grid, mapping: Mapping): BuiltRows {
  const seen = new Map<Field, number>();
  mapping.forEach(field => { if (field) seen.set(field, (seen.get(field) ?? 0) + 1); });
  const duplicateFields = [...seen].filter(([, n]) => n > 1).map(([field]) => field);
  const rows: ManualRow[] = [];
  const errors: RowError[] = [];
  grid.rows.forEach((cells, index) => {
    const line = index + 2;
    const metrics: Partial<Record<ManualMetric, number>> = {};
    let postId: string | null = null, url: string | null = null, postedAt: string | null = null, title: string | null = null;
    let broken = false;
    mapping.forEach((field, column) => {
      const cell = cells[column] ?? '';
      if (!field || broken) return;
      if (field === 'postId') postId = cell || null;
      else if (field === 'title') title = cell || null;
      else if (field === 'url') {
        if (!cell) return;
        try {
          const parsed = new URL(cell);
          if (parsed.protocol !== 'https:') throw new Error('scheme');
          url = parsed.href;
        } catch { errors.push({ line, code: 'URL_INVALID', column }); broken = true; }
      } else if (field === 'postedAt') {
        const date = parseDate(cell);
        if (date === null) { errors.push({ line, code: 'DATE_INVALID', column }); broken = true; } else postedAt = date ?? null;
      } else {
        const value = parseNumber(cell, field === 'completion_rate');
        if (value === null || (field === 'completion_rate' && value !== undefined && value > 100)) {
          errors.push({ line, code: 'NUMBER_INVALID', column });
          broken = true;
        } else if (value !== undefined) metrics[field] = value;
      }
    });
    if (broken) return;
    const postKey = postId ?? url;
    if (!postKey) { errors.push({ line, code: 'POST_KEY_MISSING' }); return; }
    if (Object.keys(metrics).length === 0) { errors.push({ line, code: 'METRICS_EMPTY' }); return; }
    rows.push({ postKey: String(postKey).slice(0, 256), url, postedAt, titleExcerpt: title ? [...String(title)].slice(0, 120).join('') : null,
      metrics });
  });
  return { rows, errors, duplicateFields };
}
