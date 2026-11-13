/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ToolAvailability } from '@repo/api/src/services/turn/tools/types';
import { CONTENT_SOURCE_MESSAGES } from '@repo/api/src/shared/contentSourceMessages';
import { POSITIONING_REQUIRED_NOTICE } from './gate-notices';

/*
 * CORE-PATH-V2 V2-10: what the page says for a turn's fixed codes and for its `opened` event. `kept` marks a code that proves the
 * message was not stored, so its text goes back into the box; any other outcome may have been processed and is read back instead.
 */
export const TURN_CONTINUE = '继续';
export const TURN_PAUSED_NOTICE = '积分不足，这一轮已暂停，已完成的部分不会重复扣费。充值后点继续。超过 24 小时未继续会自动退回。';
const REFUSED: Record<string, string> = {
  TURN_INSUFFICIENT_CREDITS: '积分不足，这条消息没有发送，也没有扣费。充值后可以再次发送。',
  TURN_RATE_LIMITED: '发送太频繁，这条消息没有发送。请稍后再试。',
  TURN_NEW_CALLS_PAUSED: '服务暂时暂停了新请求，这条消息没有发送，也没有扣费。',
  TURN_LIMIT_UNAVAILABLE: '暂时无法确认用量，这条消息没有发送，也没有扣费。请稍后再试。',
  STOP_LOSS_REACHED: '今天服务的用量已达上限，这条消息没有发送，也没有扣费。请稍后再试。',
  TURN_SESSION_BUSY: '这个对话还有一轮回复没结束，请等它完成后再发送。',
  TURN_INPUT_TOO_LARGE: '这条消息太长，超过了模型的输入上限。请缩短后再发送。',
  TURN_IMAGE_INVALID: '这张截图读不了（需要压缩后不超过 600 KB、边长不超过 2048 像素），这条消息没有发送，也没有扣费。请换一张截图再试。',
  TURN_IMAGE_UNSUPPORTED: '当前模型不支持看图，这条消息没有发送，也没有扣费。可以去掉截图，或把截图里的数字直接打出来再发送。',
  TURN_CORE_DISABLED: '对话服务正在切换，请刷新页面后再试。',
  TURN_SESSION_ERASED: '这个对话已删除。',
  TURN_SESSION_DENIED: '无法访问这个对话。',
  TURN_ACCOUNT_DENIED: '当前账号无法发送消息。',
  TURN_ACCOUNT_ERASING: '账号正在注销，无法发送消息。',
  TURN_SKILL_UNAVAILABLE: '所选技能现在用不了，这条消息没有发送，也没有扣费。可以换一个技能，或不选技能再发送。',
  TURN_REFERENCES_UNAVAILABLE: '引用的资料现在读不了，这条消息没有发送，也没有扣费。可以去掉引用再发送。',
  TURN_CREDIT_ACCOUNT_REVIEW: '你的积分账户状态需要我们核对，这条消息没有发送，也没有扣费。请提交工单，我们帮你处理。',
  TURN_RESUME_COST_PENDING: '上一步的费用还在核对，请稍后再点继续。',
  TURN_RESUME_DENIED: '这一轮已经结束，请刷新后查看结果。',
  TURN_RESUME_INPUT_LOST: '这一轮无法继续，已全额退回积分。请重新发送。',
  TURN_UNAUTHENTICATED: '登录已过期，请重新登录后再发送。',
  POSITIONING_REQUIRED: POSITIONING_REQUIRED_NOTICE,
  OPC_BUSINESS_ARCHIVED: '这个业务已归档，这条消息没有发送，也没有扣费。',
  OPC_VIDEO_TYPE_REQUIRED: '这条选题不是视频类型，不能生成口播稿或分镜，这条消息没有发送，也没有扣费。',
  OPC_CONTENT_BINDING: '分镜或剪辑的准备内容已变化，这条消息没有发送，也没有扣费。请刷新后再试。',
  ...CONTENT_SOURCE_MESSAGES,
};
const FAILED: Record<string, string> = {
  TURN_WORK_SOURCE_ERASED: '这条选题的来源稿件刚被删除或更换，这条消息没有发出，积分已退回。请刷新后再试。',
  TURN_TOMBSTONED: '这个对话已删除，本轮回复没有保存。',
  TURN_PROVIDER_402: '模型服务暂时不可用，本轮已全额退回积分。',
  TURN_PROVIDER_BUSY: '模型服务繁忙，本轮已全额退回积分。请稍后再试。',
  // The model is held for a price check (one receipt went above its frozen bound); nothing was sent for this call. It does not say
  // "pick another model": the system chooses the model (the composer only shows Auto), so that is advice the user cannot follow.
  TURN_MODEL_METERING_BLOCKED: '这个模型暂时停用，这一轮没有完成，积分已退回。请稍后再试。',
  TURN_PAUSED_FOR_CREDITS: TURN_PAUSED_NOTICE,
  // A turn with a screenshot cannot pause (a resume could not send the image to the model again): it ends refunded instead.
  TURN_IMAGE_CREDITS_LOW: '积分不足，带截图的这一轮没有完成，已全额退回积分。充值后请重新附上截图发送。',
  // Owner 2026-11-11: a turn cut off saved no answer and charges nothing; its freeze returns once the provider cost is known.
  TURN_CALL_UNKNOWN: '模型回复中断，这一轮没有完成，不扣积分；已冻结的积分核对后会退回。',
  // The call broke off after part of the reply was shown: that part is saved as the answer and the turn is charged by its usage.
  TURN_REPLY_CUT: '模型回复中途中断，已显示的内容已经保存；这一轮按实际用量扣积分，核对后以积分记录为准。',
};
const GENERIC = '这条消息没有完成。请刷新后查看结果，不要重复发送相同内容。';

export function turnCodeNotice(code: string): { text: string; kept: boolean } {
  if (REFUSED[code]) return { text: REFUSED[code], kept: true };
  // An unknown code is shown, small, so the next failure says what it was.
  return { text: FAILED[code] ?? `${GENERIC}（代码 ${code}）`, kept: false };
}

const TOOL_LABEL: Record<string, string> = { social_search: '社媒搜索', social_account: '账号数据', web_search: '网页搜索', web_fetch: '网页读取',
  read_source: '读取资料', load_skill: '加载技能', read_skill_file: '读取技能文件', list_image_templates: '图片模板', generate_image: 'Shotviva 生图' };
const REASON_LABEL: Record<string, string> = { capacity: '本轮内容已接近输入上限', disabled: '暂未开启', no_route: '暂不可用', no_key: '暂不可用', limit: '本轮次数已用完',
  not_entitled: 'Pro 或 Gold 会员可用', not_linked: '还没连接 Shotviva 账号' };

/** 2.7: a tool the turn cannot use is never dropped silently. One line per reason, in the order the server sent them. */
export function trimmedToolNotices(tools: ToolAvailability | undefined): string[] {
  const groups = new Map<string, string[]>();
  for (const { name, reason } of tools?.trimmed ?? []) {
    const label = REASON_LABEL[reason] ?? '暂不可用';
    groups.set(label, [...(groups.get(label) ?? []), TOOL_LABEL[name] ?? name]);
  }
  return [...groups].map(([reason, names]) => `本轮不能使用${names.join('、')}：${reason}。`);
}
