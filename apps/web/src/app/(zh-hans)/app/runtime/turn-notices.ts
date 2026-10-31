/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ToolAvailability } from '@repo/api/src/services/turn/tools/types';
import { POSITIONING_REQUIRED_NOTICE } from './gate-notices';

/*
 * CORE-PATH-V2 V2-10: what the page says for a turn's fixed codes and for its `opened` event. `kept` marks a code that proves the
 * message was not stored, so its text goes back into the box; any other outcome may have been processed and is read back instead.
 */
const REFUSED: Record<string, string> = {
  TURN_INSUFFICIENT_CREDITS: '积分不足，这条消息没有发送，也没有扣费。充值后可以再次发送。',
  TURN_RATE_LIMITED: '发送太频繁，这条消息没有发送。请稍后再试。',
  TURN_NEW_CALLS_PAUSED: '服务暂时暂停了新请求，这条消息没有发送，也没有扣费。',
  TURN_LIMIT_UNAVAILABLE: '暂时无法确认用量，这条消息没有发送，也没有扣费。请稍后再试。',
  TURN_SESSION_BUSY: '这个对话还有一轮回复没结束，请等它完成后再发送。',
  TURN_INPUT_TOO_LARGE: '这条消息太长，超过了模型的输入上限。请缩短后再发送。',
  TURN_CORE_DISABLED: '对话服务正在切换，请刷新页面后再试。',
  TURN_SESSION_ERASED: '这个对话已删除。',
  TURN_SESSION_DENIED: '无法访问这个对话。',
  TURN_ACCOUNT_DENIED: '当前账号无法发送消息。',
  TURN_ACCOUNT_ERASING: '账号正在注销，无法发送消息。',
  TURN_SKILL_UNAVAILABLE: '所选技能现在用不了，这条消息没有发送，也没有扣费。可以换一个技能，或不选技能再发送。',
  TURN_REFERENCES_UNAVAILABLE: '引用的资料现在读不了，这条消息没有发送，也没有扣费。可以去掉引用再发送。',
  TURN_UNAUTHENTICATED: '登录已过期，请重新登录后再发送。',
  POSITIONING_REQUIRED: POSITIONING_REQUIRED_NOTICE,
};
const FAILED: Record<string, string> = {
  TURN_TOMBSTONED: '这个对话已删除，本轮回复没有保存。',
  TURN_PROVIDER_402: '模型服务暂时不可用，本轮已全额退回积分。',
  TURN_PROVIDER_BUSY: '模型服务繁忙，本轮已全额退回积分。请稍后再试。',
  TURN_CALL_UNKNOWN: '模型回复中断，正在核对本轮结果，已用积分以记录为准。',
};
const GENERIC = '这条消息没有完成。请刷新后查看结果，不要重复发送相同内容。';

export function turnCodeNotice(code: string): { text: string; kept: boolean } {
  if (REFUSED[code]) return { text: REFUSED[code], kept: true };
  return { text: FAILED[code] ?? GENERIC, kept: false };
}

const TOOL_LABEL: Record<string, string> = { social_search: '社媒搜索', social_account: '账号数据', web_search: '网页搜索', web_fetch: '网页读取',
  read_source: '读取资料', load_skill: '加载技能', read_skill_file: '读取技能文件' };
const REASON_LABEL: Record<string, string> = { capacity: '本轮内容已接近输入上限', disabled: '暂未开启', no_route: '暂不可用', no_key: '暂不可用', limit: '本轮次数已用完' };

/** 2.7: a tool the turn cannot use is never dropped silently. One line per reason, in the order the server sent them. */
export function trimmedToolNotices(tools: ToolAvailability | undefined): string[] {
  const groups = new Map<string, string[]>();
  for (const { name, reason } of tools?.trimmed ?? []) {
    const label = REASON_LABEL[reason] ?? '暂不可用';
    groups.set(label, [...(groups.get(label) ?? []), TOOL_LABEL[name] ?? name]);
  }
  return [...groups].map(([reason, names]) => `本轮不能使用${names.join('、')}：${reason}。`);
}
