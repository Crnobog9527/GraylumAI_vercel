/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * PUBLISH-MONITOR PR-7: fixed display texts for the data review page. Server codes and metric keys are never shown
 * raw; a missing metric is "平台不提供" or "未取到", never 0 (plan §5.2, §9 item 2).
 */
export const PLATFORM_NAMES: Record<string, string> = {
  x: 'X', youtube: 'YouTube', tiktok: 'TikTok', tiktok_business: 'TikTok 商业号', instagram: 'Instagram',
  facebook: 'Facebook', threads: 'Threads', linkedin: 'LinkedIn', pinterest: 'Pinterest', bluesky: 'Bluesky',
  xiaohongshu: '小红书', douyin: '抖音',
};
export const platformName = (platform: string) => PLATFORM_NAMES[platform] ?? platform;

/** Brand-account platforms that connect through Post for Me (names must match exactly, see connect.ts). */
export const POST_FOR_ME_PLATFORMS = ['x', 'youtube', 'tiktok', 'tiktok_business', 'instagram', 'facebook', 'threads',
  'linkedin', 'pinterest', 'bluesky'] as const;
/** Own accounts read from public data through TikHub, by profile link. */
export const PROFILE_LINK_PLATFORMS = ['xiaohongshu', 'douyin'] as const;
/** These cannot be asked for read-only access: the consent also grants publishing (plan §9 item 21). */
export const COMBINED_AUTH_PLATFORMS = ['x', 'bluesky'];

export type ConnectRoute = 'postforme' | 'profile_link' | 'unsupported';
export function connectRoute(platform: string): ConnectRoute {
  if ((POST_FOR_ME_PLATFORMS as readonly string[]).includes(platform)) return 'postforme';
  if ((PROFILE_LINK_PLATFORMS as readonly string[]).includes(platform)) return 'profile_link';
  return 'unsupported';
}

export const METRIC_LABELS: Record<string, string> = {
  views: '播放/浏览', impressions: '曝光', reach: '覆盖人数', likes: '点赞', comments: '评论', shares: '分享',
  saves: '收藏', favorites: '收藏', followers_gained: '带来关注', profile_visits: '主页访问', completion_rate: '完播率',
  engagement_rate: '互动率', followers: '粉丝', video_views: '播放', reposts: '转发', quotes: '引用',
};
/** Shown in this order; anything else the platform returns follows, under its own label or key. */
export const METRIC_ORDER = ['views', 'impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'favorites',
  'followers_gained', 'profile_visits', 'completion_rate'];
export const metricLabel = (key: string) => METRIC_LABELS[key] ?? key;

export function formatMetric(key: string, value: number): string {
  if (key === 'completion_rate') return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
  if (key === 'engagement_rate') return `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** One metric cell: the number, "平台不提供" when the platform says so, otherwise "未取到". Never 0 for missing. */
export function metricCell(key: string, snapshot: { metrics: Record<string, number>; missingFields: string[] } | null) {
  if (!snapshot) return '未取到';
  if (snapshot.missingFields.includes(key)) return '平台不提供';
  const value = snapshot.metrics[key];
  return value === undefined || !Number.isFinite(value) ? '未取到' : formatMetric(key, value);
}

/** Metric columns for a set of snapshots: known ones first, then the rest, without inventing any. */
export function metricColumns(snapshots: Array<{ metrics: Record<string, number>; missingFields: string[] } | null>) {
  const keys = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    for (const key of Object.keys(snapshot.metrics)) keys.add(key);
    for (const key of snapshot.missingFields) keys.add(key);
  }
  return [...METRIC_ORDER.filter(key => keys.has(key)), ...[...keys].filter(key => !METRIC_ORDER.includes(key)).sort()];
}

export const CONNECTION_STATUS: Record<string, string> = {
  connected: '已连接', reauth_required: '需要重新授权', quarantined: '已暂停（这个社媒账号被其他人重新授权）',
  disconnected: '已断开',
};
export const SOURCE_LABEL: Record<string, string> = { postforme: '授权读取', tikhub: '公开数据', manual: '手动导入' };
export const POSTED_AT_SOURCE: Record<string, string> = { provider: '', x_snowflake: '（按作品编号推算）', user: '（手动填写）' };

export function formatDay(value: string | null): string {
  if (!value) return '未提供';
  // A date-only value is a calendar day, not an instant: shown as is, never shifted by the viewer's time zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString('sv-SE') : '未提供';
}
export function formatTime(value: string | null): string {
  if (!value) return '还没有成功读取';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '还没有成功读取';
}

const MESSAGES: Record<string, string> = {
  PUBLISH_MONITOR_DISABLED: '作品数据和复盘还没有开放。',
  PUBLISH_MONITOR_ENTITLEMENT_REQUIRED: '这项功能需要会员。Pro 可以看自己作品近 30 天数据，Gold 另有对标监控、90 天趋势和每周自动复盘。',
  PUBLISH_MONITOR_REVIEW_DISABLED: '每周复盘还没有开放。',
  PUBLISH_MONITOR_ACCOUNT_CLOSED: '账号已注销或停用。',
  PUBLISH_MONITOR_CONNECTION_NOT_FOUND: '这个连接不存在或已经删除，请刷新页面。',
  PUBLISH_MONITOR_ACCOUNT_NOT_FOUND: '找不到这个品牌账号，请刷新页面。',
  PUBLISH_MONITOR_POST_NOT_FOUND: '找不到这条作品，请刷新页面。',
  PUBLISH_MONITOR_BUSINESS_NOT_FOUND: '找不到这个定位档案，请刷新页面。',
  PUBLISH_MONITOR_BUSINESS_NOT_READY: '这个定位档案还没有确认的定位，请先完成并确认定位，再添加账号。',
  PUBLISH_MONITOR_PLATFORM_HAS_ACCOUNT: '这个定位档案在这个平台已经有一个账号了，一个平台只能有一个账号。',
  PUBLISH_MONITOR_ACCOUNT_EXISTS_ELSEWHERE: '这个账号名已经在你的另一个定位档案下了，请换一个，或到那个档案里使用。',
  PUBLISH_MONITOR_WORK_ITEM_MISMATCH: '只能关联同一个品牌账号下你自己的内容。',
  PUBLISH_MONITOR_REFRESH_UNAVAILABLE: '这个账号现在不能刷新（可能需要重新授权，或没有打开读取）。',
  PUBLISH_MONITOR_REFRESH_RUNNING: '正在更新这个账号的数据，请稍后再看。',
  PUBLISH_MONITOR_PROFILE_LINK_INVALID: '没认出这个主页链接，请粘贴完整的个人主页链接。',
  PUBLISH_MONITOR_PLATFORM_UNSUPPORTED: '这个平台暂不支持。',
  PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED: '这个品牌账号已经连接了另一个社媒账号，请先断开再连接。',
  PUBLISH_MONITOR_BENCHMARK_EXISTS: '这个对标账号已经在监控了。',
  PUBLISH_MONITOR_BENCHMARK_LIMIT: '这个品牌的对标账号已经达到上限。',
  PUBLISH_MONITOR_IMPORT_INVALID: '有的行内容不符合要求，请检查后再导入。',
  PUBLISH_MONITOR_PROVIDER_UNAVAILABLE: '连接服务暂时不可用，请稍后再试。',
  PUBLISH_MONITOR_PROVIDER_BUSY: '连接服务繁忙，请稍后再试。',
  PUBLISH_MONITOR_REVIEW_NOT_FOUND: '找不到这份复盘。',
  rate_limited: '操作太频繁了。同一个账号 1 小时内只能手动刷新 1 次，请稍后再试。',
  LOGIN_REQUIRED: '请先登录。',
  MAINTENANCE: '系统维护中，请稍后再试。',
};
export function dataErrorMessage(code: string | null | undefined): string {
  return (code && MESSAGES[code]) || '暂时读不到，请稍后重试。';
}
/** tRPC errors carry the server code as their message (a rate limit carries readable text and TOO_MANY_REQUESTS). */
export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const data = 'data' in error ? (error.data as { code?: unknown } | null | undefined) : null;
  if (data?.code === 'TOO_MANY_REQUESTS') return 'rate_limited';
  return 'message' in error && typeof error.message === 'string' ? error.message : null;
}
