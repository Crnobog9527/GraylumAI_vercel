/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { CHAT_ACTION, type ChatNotice } from '@/components/chat/ChatInlineNotice';
import { OUTPUT_TRUNCATED_NOTICE, PROVIDER_HISTORY_NOTICE, HISTORY_OMITTED_NOTICE } from '@/lib/runtime-gate-notice';

/** A frozen guidance request without its execution, waiting for the user's explicit retry. */
export const GUIDE_HELD_NOTICE = '引导请求待恢复。点“重试”会沿用原请求，不会另开一次。';
/** Shown only for a stop the user asked for in this browser. */
export const USER_STOP_NOTICE = '已停止，保留原记录。';
/**
 * Any other cancelled turn: the server ended it (provider refusal, moderation, a failed or timed-out
 * call, an unfinished financial recovery). It is not a stop the user asked for, so it never says 已停止.
 */
export const ENDED_NOTICE = '这一轮没有完成，已结束。原记录已保留，不会自动重试；可以重新发送。';
export const CAPACITY_NOTICE = '本次必要材料超过模型输入容量，原请求和已完成内容已保留。停止后可缩短材料再新发请求。';

export type RuntimeTurn = {
  executionId: string; state: string; primaryBody: string | null; organizerComplete: boolean | null;
  needsTask: boolean; unavailableReason: string | null; historyOmitted?: boolean;
};

const open = (state: string) => state !== 'completed' && state !== 'cancelled';

/**
 * Notices shown under one turn, in the conversation. Every still-open turn gets one notice
 * carrying its "重试" (resume the same execution) and "停止" (cancel what remains) actions.
 */
export function runtimeTurnNotices(turn: RuntimeTurn, ctx: {
  busy: boolean; capacity: boolean; gateStop?: string; userStopped?: boolean; stopping: boolean;
  onRetry: () => void; onStop: () => void;
}): ChatNotice[] {
  const id = (suffix: string) => turn.executionId + ':' + suffix;
  const notices: ChatNotice[] = [];
  if (turn.primaryBody && !turn.organizerComplete) notices.push({ id: id('organizer'), tone: 'status', text: '主回复已保存，附属整理未完成。' });
  if (turn.unavailableReason === 'provider_history')
    return [{ id: id('history'), tone: 'warning', text: PROVIDER_HISTORY_NOTICE }];
  if (turn.historyOmitted)
    notices.push({ id: id('history-omitted'), tone: 'status', text: HISTORY_OMITTED_NOTICE });
  if (turn.state === 'cancelled')
    notices.push(ctx.gateStop ? { id: id('cancelled'), tone: 'warning', text: ctx.gateStop }
      : ctx.userStopped ? { id: id('cancelled'), tone: 'status', text: USER_STOP_NOTICE } : { id: id('cancelled'), tone: 'warning', text: ENDED_NOTICE });
  if (turn.needsTask)
    notices.push({ id: id('task'), tone: 'warning', text: '当前入口暂不支持这个 Skill 的任务选择。可点“停止”后使用普通对话。' });
  if (turn.unavailableReason === 'output_truncated') notices.push({ id: id('truncated'), tone: 'warning', text: OUTPUT_TRUNCATED_NOTICE });
  if (turn.unavailableReason === 'latest_unavailable')
    notices.push({ id: id('latest'), tone: 'warning', text: '本次未取得搜索资料，无法提供已核实的最新信息。' });
  if (!open(turn.state)) return notices;
  const capacity = ctx.capacity;
  const stop = { label: CHAT_ACTION.stop, onClick: ctx.onStop, disabled: ctx.stopping };
  const retry = { label: CHAT_ACTION.retry, onClick: ctx.onRetry, disabled: ctx.busy };
  const running = ctx.busy && !capacity && turn.state !== 'cost_pending';
  notices.push({
    id: id('open'),
    tone: running ? 'status' : 'warning',
    busy: running,
    text: capacity ? CAPACITY_NOTICE : turn.state === 'cost_pending' ? '费用待核实；重试只核对原调用。'
      : running ? '正在回复…' : '回复尚未完成，原请求已保留。',
    actions: capacity ? [stop] : [retry, stop],
  });
  return notices;
}

/**
 * Notices after the last turn. The guidance retry is keyed on the held request (state), never
 * on the wording of the last error; an error already shown under the last turn is not repeated.
 */
export function runtimeTailNotices(ctx: {
  error: string; heldGuide: boolean; busy: boolean; onGuide: () => void;
  lastTurn?: { open: boolean; texts: readonly string[] };
}): ChatNotice[] {
  const notices: ChatNotice[] = [];
  if (ctx.heldGuide)
    notices.push({ id: 'guide', tone: 'warning', text: GUIDE_HELD_NOTICE, label: '引导待重试',
      actions: [{ label: CHAT_ACTION.retry, onClick: ctx.onGuide, disabled: ctx.busy }] });
  const repeated = ctx.lastTurn?.texts.includes(ctx.error) || (ctx.heldGuide && ctx.error === GUIDE_HELD_NOTICE);
  if (ctx.error && !repeated) notices.push({ id: 'error', tone: 'error', text: ctx.error });
  if (ctx.busy && !ctx.lastTurn?.open) notices.push({ id: 'busy', tone: 'status', busy: true, text: '正在处理，请稍候…' });
  return notices;
}

export function isOpenTurn(state: string) {
  return open(state);
}
