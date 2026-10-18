/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure helpers for the PAY-FOUNDER admin page (member list, community bookkeeping, wall review).

export type FounderState = 'none' | 'active' | 'grace' | 'frozen' | 'ended';

export interface FounderOverviewRow {
  userId: string;
  email: string | null;
  founder: { state: FounderState; periodEnd: string | null; deadline: string | null; endedAt: string | null;
    endedReason: 'refunded' | 'lapsed' | 'expired' | null };
  foundedAt: string | null;
  accountOpen: boolean;
  community: { joinedAt: string | null; removedAt: string | null };
  pendingRemoval: boolean;
  wall: {
    displayName: string; socialAccounts: { platform: string; handle: string; url: string }[];
    productName: string | null; productUrl: string | null; intro: string | null;
    reviewState: 'pending' | 'approved' | 'rejected'; updatedAt: string; consented: boolean; listed: boolean;
  } | null;
}

export const STATE_LABEL: Record<FounderState, string> = {
  none: '无',
  active: '有效',
  grace: '宽限期（7 天内可续）',
  frozen: '拒付冻结中（临时）',
  ended: '已结束',
};

export const ENDED_REASON_LABEL = { refunded: '已退款', lapsed: '到期没续', expired: '到期' } as const;

export const REVIEW_LABEL = { pending: '待审核', approved: '已通过', rejected: '已拒绝' } as const;

export const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音', xiaohongshu: '小红书', wechat_channels: '视频号', bilibili: 'B 站', weibo: '微博', kuaishou: '快手',
  youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', x: 'X', facebook: 'Facebook', linkedin: 'LinkedIn',
  other: '其他',
};

export function formatDay(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function stateText(row: FounderOverviewRow) {
  const base = STATE_LABEL[row.founder.state];
  if (row.founder.state === 'ended' && row.founder.endedReason) return `${base}（${ENDED_REASON_LABEL[row.founder.endedReason]}）`;
  return base;
}

export function communityText(row: FounderOverviewRow) {
  if (row.community.removedAt) return `已移出（${formatDay(row.community.removedAt) ?? ''}）`;
  if (row.community.joinedAt) return `已入群（${formatDay(row.community.joinedAt) ?? ''}）`;
  return '未入群';
}

/** Members whose identity ended but who are still marked in the group; frozen never counts. */
export function pendingRemovalRows(rows: FounderOverviewRow[]) {
  return rows.filter(row => row.pendingRemoval && row.founder.state === 'ended');
}

export function wallQueue(rows: FounderOverviewRow[]) {
  return rows.filter(row => row.wall && row.wall.consented && row.wall.reviewState === 'pending');
}

const ERRORS: Record<string, string> = {
  FOUNDER_ADMIN_DENIED: '当前账号无权操作。',
  FOUNDER_WALL_ENTRY_CHANGED: '这张卡片刚被会员修改过，已刷新，请重新审核。',
  FOUNDER_WALL_ENTRY_MISSING: '这张卡片已被会员撤回。',
  FOUNDER_COMMUNITY_NOT_JOINED: '这位会员还没有标记入群，不能标记移出。',
  FOUNDER_NOT_FOUND: '没有找到这位创始会员。',
  FOUNDER_LINK_INVALID: '链接必须是 https:// 开头的外部地址，且不能带用户名或密码。',
  FOUNDER_TEXT_INVALID: '内容不能为空，也不能含控制字符。',
  FOUNDER_LIVESTREAM_INPUT_INVALID: '直播记录填写有误，请检查日期、主题和回放链接。',
};

export function founderAdminError(error: { message?: string } | null | undefined, action: 'read' | 'save') {
  const known = Object.keys(ERRORS).find(code => error?.message?.includes(code));
  if (known) return ERRORS[known];
  return action === 'read' ? '暂时无法读取创始会员数据，请稍后重试。' : '保存失败，请稍后重试；结果可能已生效，请先刷新确认。';
}
