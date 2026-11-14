/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/*
 * VOICE-2 "读取最新帖子" (Owner 2026-11-14 "加按钮，按用量扣"): what the import panel says after one billed read of an own
 * TikHub account (publishMonitor.readTikhub). No credit estimate is shown (paywall copy rules); the read is charged by what came
 * back, nothing for a failure.
 */
export type ImportReadOutcome = 'read' | 'not_fetched' | 'insufficient_credits' | 'unavailable';
export type ImportReadNotice = { tone: 'ok' | 'error'; text: string };

export const IMPORT_READ_HINT = '读取一次这个账号最新一页帖子（最多 30 条），按实际用量扣积分，读取失败不扣；每个账号每小时一次。';

const OUTCOMES: Record<ImportReadOutcome, ImportReadNotice> = {
  read: { tone: 'ok', text: '已读取最新帖子，可以选择导入了。' },
  not_fetched: { tone: 'error', text: '这次没有读到帖子，读取失败的部分没有扣积分。可以稍后再试。' },
  insufficient_credits: { tone: 'error', text: '积分不够，这次没有读完。充值后可以马上再读。' },
  unavailable: { tone: 'error', text: '读取暂时不可用，没有扣积分，请稍后再试。' },
};
const ERRORS: Record<string, string> = {
  rate_limited: '同一个账号 1 小时内只能读取 1 次，请稍后再试。',
  PUBLISH_MONITOR_REFRESH_RUNNING: '这个账号正在读取中，请稍等一会儿再看。',
  PUBLISH_MONITOR_REFRESH_UNAVAILABLE: '这个账号现在不能读取（可能已断开或没有授权读取）。',
  PUBLISH_MONITOR_ENTITLEMENT_REQUIRED: '当前会员不包含读取账号数据，升级后可以使用。',
  PUBLISH_MONITOR_CONNECTION_NOT_FOUND: '这个连接不存在或已经删除，请刷新页面。',
  PUBLISH_MONITOR_DISABLED: '账号数据功能暂时关闭，请稍后再试。',
};

export const importReadNotice = (outcome: ImportReadOutcome): ImportReadNotice => OUTCOMES[outcome];
/** `code` comes from publish-monitor's errorCode (a rate limit is "rate_limited"). */
export function importReadError(code: string | null): ImportReadNotice {
  return { tone: 'error', text: (code && ERRORS[code]) || '读取结果暂时不确定，请稍后刷新查看；再点一次不会重复扣费。' };
}
