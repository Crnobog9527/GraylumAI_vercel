/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * PUBLISH-MONITOR PR-5 publish page: pure helpers (targets, keys, texts). The server decides everything; these only
 * shape what the page shows and sends.
 */

export const PLATFORM_NAMES: Record<string, string> = { x: 'X', youtube: 'YouTube', tiktok: 'TikTok',
  tiktok_business: 'TikTok 商业号', instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads', linkedin: 'LinkedIn',
  pinterest: 'Pinterest', bluesky: 'Bluesky' };
export const platformName = (platform: string) => PLATFORM_NAMES[platform] ?? platform;

// Caption length each platform accepts (characters); a longer caption is shown as a warning, the platform decides.
const CAPTION_LIMITS: Record<string, number> = { x: 280, bluesky: 300, threads: 500, pinterest: 500, tiktok: 2200,
  tiktok_business: 2200, instagram: 2200, linkedin: 3000, youtube: 5000, facebook: 63206 };
export function captionTooLong(caption: string, platforms: string[]): string[] {
  const length = [...caption].length;
  return platforms.filter(platform => length > (CAPTION_LIMITS[platform] ?? Infinity));
}

// Platforms whose publish authorization needs more than one click (a connection type or an app password) are
// upgraded from the account connection page instead.
const ONE_CLICK_AUTHORIZE = new Set(['x', 'youtube', 'tiktok', 'tiktok_business', 'threads', 'pinterest']);
export const authorizeHere = (platform: string) => ONE_CLICK_AUTHORIZE.has(platform);

export type Connection = { id: string; businessId: string; accountProjectId: string | null; role: 'own' | 'benchmark';
  source: 'postforme' | 'tikhub' | 'manual'; platform: string; displayHint: string | null;
  status: 'connected' | 'reauth_required' | 'quarantined' | 'disconnected'; consentPublish: boolean };
export type Target = Connection & { ready: boolean };

/**
 * The brand's own Post for Me accounts on platforms open for publishing. A platform not open is never listed; a
 * connected account without publishing consent is listed but not selectable.
 */
export function publishTargets(connections: Connection[], businessId: string, open: string[]): Target[] {
  const allowed = new Set(open);
  return connections
    .filter(c => c.businessId === businessId && c.role === 'own' && c.source === 'postforme' && allowed.has(c.platform)
      && c.status === 'connected')
    .map(c => ({ ...c, ready: c.consentPublish }))
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

/** One key per publish attempt; a retry after a failure is a new attempt with a fresh upload (plan §2.1). */
export function newIdempotencyKey(): string {
  return `pub-${crypto.randomUUID()}`;
}

export const MAX_CAPTION = 5000;
export const MAX_COVER_MS = 24 * 3600 * 1000;

const MESSAGES: Record<string, string> = {
  PUBLISH_MONITOR_QUOTA_EXHAUSTED: '发布通道暂时繁忙，稍后自动恢复。这次没有扣积分。',
  PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED: '发布通道暂时繁忙，稍后自动恢复。这次没有扣积分。',
  PUBLISH_MONITOR_PRICE_NOT_CONFIGURED: '一键发布暂时不可用，请稍后再试。这次没有扣积分。',
  PUBLISH_MONITOR_INSUFFICIENT_CREDITS: '积分不够这次发布，请先充值再发。这次没有扣积分。',
  PUBLISH_MONITOR_TOO_MANY_REJECTIONS: '最近几次发布都被平台拒绝了，请一小时后再试，或检查素材和文案是否符合平台要求。',
  PUBLISH_MONITOR_IDEMPOTENCY_MISMATCH: '这是一次新的发布，请重新提交。',
  PUBLISH_MONITOR_TARGET_INVALID: '选中的账号不能发布（可能已断开或没有授权发布），请刷新页面后重选。',
  PUBLISH_MONITOR_WORK_ITEM_INVALID: '这条选题不属于这个品牌，不能从这里发布。',
  PUBLISH_MONITOR_PLATFORM_NOT_OPEN: '这个平台的一键发布还没开放。',
  PUBLISH_MONITOR_ENTITLEMENT_REQUIRED: '一键发布需要 Pro 或 Gold 会员。',
  PUBLISH_MONITOR_DISABLED: '一键发布还没有开放。',
  PUBLISH_MONITOR_ACCOUNT_CLOSED: '账号已注销或停用，不能发布。',
  PUBLISH_MONITOR_JOB_NOT_FOUND: '找不到这次发布。',
  MEDIA_TYPE_UNSUPPORTED: '只能发布图片或视频文件。',
  MEDIA_TOO_LARGE: '每次最多 10 个文件，单个文件不超过 1GB。',
  MEDIA_UPLOAD_FAILED: '素材上传没有完成，这次没有发布、没有扣积分。请重新提交（会重新上传）。',
  LOGIN_REQUIRED: '请先登录。',
};

/** Fixed readable texts per refusal code (never raw server text). Rate limits come back as TOO_MANY_REQUESTS. */
export function publishErrorMessage(code: string | null | undefined, httpCode?: string): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (httpCode === 'TOO_MANY_REQUESTS') return '操作太频繁或发布通道繁忙，请稍后再试。';
  return '发布暂时没有完成，请稍后重试。';
}

export type JobState = 'claimed' | 'dispatching' | 'unknown' | 'completed' | 'failed' | 'released';
export const JOB_OPEN = (state: JobState) => state === 'claimed' || state === 'dispatching' || state === 'unknown';

export function jobSummary(state: JobState, manualReview: boolean): string {
  if (manualReview) return '结果还没确认，已转人工核对。积分暂时冻结，确认没发出会退回；不会重复发。';
  if (state === 'claimed' || state === 'dispatching') return '正在发布……';
  if (state === 'unknown') return '已提交，正在等平台结果。积分暂时冻结，只按发布成功的平台扣；不会重复发。';
  if (state === 'completed') return '发布完成。只按发布成功的平台扣了积分。';
  if (state === 'failed') return '这次没有发布成功，积分已全部退回。可以重新提交（素材会重新上传）。';
  return '这次没有发出，积分已全部退回。可以重新提交（素材会重新上传）。';
}
