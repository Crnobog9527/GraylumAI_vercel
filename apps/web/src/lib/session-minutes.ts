/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** CONTENT-CONVERSATION-2: the page's words for the minutes ("整理纪要" / "整理本选题"); the panel is components/opc/session-minutes. */
export type MinutesItem = {
  turnId: number; requestId: string; state: string; closeKind: string | null; failureCode: string | null; chargedCredits: number | null;
  openedAt: string; closedAt: string | null; body: string | null; available: boolean;
};

const NOTICES: Record<string, string> = {
  LOST: '整理请求的结果还没收到。再点一次会继续同一次整理，不会重复扣费。',
  MINUTES_EMPTY: '这段对话还没有内容，暂时不能整理。',
  MINUTES_EMPTY_ANSWER: '这次整理没有得到内容，没有扣费，请稍后再试。',
  TURN_SESSION_BUSY: '这段对话正在回复，等它写完再整理。',
  TURN_INSUFFICIENT_CREDITS: '积分不足，充值后再整理。',
  TURN_PAUSED_FOR_CREDITS: '积分不足，这次整理没有完成，没有扣费。充值后再整理。',
  TURN_RATE_LIMITED: '操作太频繁，请稍后再整理。',
  TURN_NEW_CALLS_PAUSED: '服务暂时暂停新的请求，请稍后再整理。',
  MINUTES_MODEL_NOT_CONFIGURED: '整理功能暂时不可用，请稍后再试。',
  MINUTES_MODEL_UNAVAILABLE: '整理功能暂时不可用，请稍后再试。',
  TURN_SESSION_ERASED: '这段对话已删除，不能整理。',
  TURN_CALL_UNKNOWN: '整理结果暂时不确定，稍后刷新查看；不会重复扣费。',
};
/** One plain line for a refusal or a failure of the minutes; never the code itself. */
export const minutesNotice = (code: string) => NOTICES[code] ?? '这次整理没有完成，请稍后再试。';

/** "纪要-2026-11-14-0930.md", in the user's local time. */
export function minutesFileName(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `纪要-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.md`;
}
