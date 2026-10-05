/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { type ChatNotice } from '@/components/chat/ChatInlineNotice';
import { gateResultNotice } from '@/lib/runtime-gate-notice';
import { profileTabHref } from '@/lib/profile-tabs';

/**
 * BILL-PAYG pauses (#631, #632) on the chat surfaces. A pay-as-you-go turn pauses between
 * two calls when credits run short (`waiting_credits`) or its time budget ends
 * (`waiting_resume`). Only the user's explicit "继续" resumes it, through `runtime.resume`
 * with the turn's own executionId/cursor/epoch from the session view: never a new request,
 * never a new admission, and finished calls are not charged again.
 */
export const WAITING_CREDITS_NOTICE = '积分不够，这一步已暂停。充值后点“继续”，会从暂停的地方接着做，已完成的部分不会重复扣费。';
export const STILL_SHORT_NOTICE = '积分还是不够，这一步仍然暂停。充值后再点“继续”，会从暂停的地方接着做，已完成的部分不会重复扣费。';
export const WAITING_RESUME_NOTICE = '已暂停，点“继续”会接着做。';
export const RESUMING_NOTICE = '正在继续…';
/** A new message refused because this session's previous organizer has not finished. */
export const ORGANIZER_PENDING_NOTICE = '上一轮的整理还没完成，这条消息还没有发出，内容已保留。请先点“继续”或等它完成，再发送。';
/** The paused organizer ran out of calls and was closed: the main reply stays. */
export const ORGANIZER_SKIPPED_NOTICE = '本轮未整理：整理所需的调用次数已用完，主回复已保留。';
export const RESUME_ADMIN_NOTICE = '暂时无法继续：需要管理员调整配置，这一步保持暂停，已完成的内容不受影响。';
export const RESUME_CONFLICT_NOTICE = '这一步的状态已经更新，页面已重新读取，请按最新状态操作。';
export const RESUME_SOURCE_CHANGED_NOTICE = '资料或对话已经变化，这一步不能接着做。已完成的内容和费用都已保留。';
export const RESUME_CLOSED_NOTICE = '这一步已经结束，不能再继续。已完成的内容已保留。';
export const RESUME_CHECKPOINT_NOTICE = '上一次调用的费用还在核对，请稍后再点“继续”，不会重复扣费。';
export const RESUME_LIMIT_NOTICE = '这一步已达到调用次数上限，不能再继续。已完成的内容已保留。';
export const RESUME_UNKNOWN_NOTICE = '继续的结果暂未确认，页面已重新读取。请稍后再点“继续”，不会重复扣费。';

export const PAYG_ACTION = { resume: '继续', topUp: '去充值' } as const;
/** The same recharge entry as the header's "充值积分". */
export const TOP_UP_HREF = profileTabHref('subscription');

/** Exactly the `runtime.resume` input (resumeInput on the server). */
export type PaygResumeToken = { executionId: string; cursor: number; epoch: number };
/** Session view fields of one turn this module reads (runtime_view). */
export type PaygViewFields = {
  cursor?: number | null; epoch?: number | null; remainingCalls?: number | null;
  primaryBody?: string | null; organizerComplete?: boolean | null;
};
export type PaygTurn = PaygViewFields & { executionId: string; state: string };

const PAUSED = ['waiting_credits', 'waiting_resume'];
export function isPaygWaiting(state: unknown): state is 'waiting_credits' | 'waiting_resume' {
  return typeof state === 'string' && PAUSED.includes(state);
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The token "继续" sends, or null when the turn is not paused or the view lacks its position. */
export function paygResumeToken(turn: PaygTurn): PaygResumeToken | null {
  if (!isPaygWaiting(turn.state) || !count(turn.cursor) || !count(turn.epoch)) return null;
  return { executionId: turn.executionId, cursor: turn.cursor, epoch: turn.epoch };
}

/**
 * A cancelled turn whose main reply is saved but whose organizer never finished because the
 * run's calls were used up: the server closed it quietly (#632 P2-3).
 */
export function organizerSkipped(turn: PaygTurn) {
  return turn.state === 'cancelled' && Boolean(turn.primaryBody) && turn.organizerComplete === false && turn.remainingCalls === 0;
}

/** A turn that still holds the session's organizer: its main reply is saved, the organizer is not done. */
export function openOrganizer(turn: PaygTurn) {
  return Boolean(turn.primaryBody) && turn.organizerComplete === false && turn.state !== 'completed' && turn.state !== 'cancelled';
}

/**
 * Q1 (#632): a new message answered by the previous organizer's wait instead of an admission.
 * The new request was not stored or charged; `executionId` names the organizer turn.
 */
export function blockedAdmission(result: unknown): { executionId: string } | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as { admitted?: unknown; executionId?: unknown };
  return value.admitted === false && typeof value.executionId === 'string' ? { executionId: value.executionId } : null;
}

/** The fixed refusal of a new message while the organizer is running, interrupted or cost-pending. */
export function isOrganizerPendingError(cause: unknown) {
  return cause instanceof Error && cause.message.startsWith('RUNTIME_ORGANIZER_PENDING');
}

const resumeFailures: Record<string, string> = {
  RUNTIME_RESUME_CONFLICT: RESUME_CONFLICT_NOTICE,
  RUNTIME_RESUME_SOURCE_CHANGED: RESUME_SOURCE_CHANGED_NOTICE,
  RUNTIME_RESUME_CLOSED: RESUME_CLOSED_NOTICE,
  RUNTIME_CHECKPOINT_PENDING: RESUME_CHECKPOINT_NOTICE,
  RUNTIME_CALL_LIMIT_REACHED: RESUME_LIMIT_NOTICE,
  RUNTIME_USAGE_CONFIGURATION_REQUIRED: RESUME_ADMIN_NOTICE,
  RUNTIME_PRICE_CONFIGURATION_PENDING: RESUME_ADMIN_NOTICE,
};

/** Fixed text for a refused or lost resume; server text is never shown. */
export function resumeFailureNotice(cause: unknown) {
  const message = cause instanceof Error ? cause.message : '';
  const code = Object.keys(resumeFailures).find(key => message === key || message.startsWith(key + '：'));
  return code ? resumeFailures[code] : RESUME_UNKNOWN_NOTICE;
}

/** What the turn shows after its last resume returned. */
export type PaygOutcome = { kind: 'short' } | { kind: 'notice'; text: string };

/**
 * A resume that came back paused again is not an error: still short of credits goes back to
 * the waiting notice; a gate or configuration stop adds its fixed text.
 */
export function resumeOutcome(result: unknown): PaygOutcome | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as { state?: unknown; unavailable?: unknown };
  const gate = gateResultNotice(value.unavailable);
  if (gate) return { kind: 'notice', text: gate };
  if (['usage_configuration_required', 'RUNTIME_PRICE_UNCONFIRMED', 'RUNTIME_PRICE_CONFIGURATION_PENDING'].includes(String(value.unavailable)))
    return { kind: 'notice', text: RESUME_ADMIN_NOTICE };
  return value.state === 'waiting_credits' ? { kind: 'short' } : null;
}

/** Recharge in a new tab, so this turn and its "继续" stay where they are. */
export function openTopUp() {
  window.open(TOP_UP_HREF, '_blank', 'noopener');
}

/**
 * Notices under one turn: the pause with its actions, a resume outcome, or the skipped organizer.
 * `disabled` is the page's own busy state; "继续" is also off while any resume runs.
 */
export function paygTurnNotices(turn: PaygTurn, ctx: {
  resumingId: string | null; outcome?: PaygOutcome; disabled?: boolean;
  onResume: (token: PaygResumeToken) => void; onTopUp?: () => void;
}): ChatNotice[] {
  const id = (suffix: string) => turn.executionId + ':payg-' + suffix;
  if (organizerSkipped(turn)) return [{ id: id('skipped'), tone: 'status', text: ORGANIZER_SKIPPED_NOTICE }];
  if (ctx.resumingId === turn.executionId && isPaygWaiting(turn.state))
    return [{ id: id('resuming'), tone: 'status', busy: true, text: RESUMING_NOTICE }];
  const token = paygResumeToken(turn);
  if (!token) return [];
  const credits = turn.state === 'waiting_credits';
  const resume = { label: PAYG_ACTION.resume, disabled: Boolean(ctx.disabled || ctx.resumingId), onClick: () => ctx.onResume(token) };
  const notices: ChatNotice[] = [{
    id: id('wait'), tone: 'warning', label: credits ? '积分不足已暂停' : '已暂停',
    text: !credits ? WAITING_RESUME_NOTICE : ctx.outcome?.kind === 'short' ? STILL_SHORT_NOTICE : WAITING_CREDITS_NOTICE,
    actions: credits ? [resume, { label: PAYG_ACTION.topUp, onClick: ctx.onTopUp ?? openTopUp }] : [resume],
  }];
  if (ctx.outcome?.kind === 'notice') notices.push({ id: id('outcome'), tone: 'warning', text: ctx.outcome.text });
  return notices;
}

/** `blockedId` of a refusal that names no turn: the organizer is the last open one in the view. */
export const UNNAMED_ORGANIZER = 'unnamed';

/**
 * The notice after the last turn when a new message met the unfinished organizer. Its "继续"
 * resumes that organizer turn; a running organizer offers none (wait for it). The notice ends
 * once the view shows that organizer finished.
 */
export function organizerBlockedNotices(turns: readonly PaygTurn[] | undefined, blockedId: string | null, ctx: {
  resumingId: string | null; disabled?: boolean; onResume: (token: PaygResumeToken) => void;
}): ChatNotice[] {
  if (!blockedId) return [];
  const turn = blockedId === UNNAMED_ORGANIZER ? turns?.findLast(openOrganizer)
    : turns?.find(candidate => candidate.executionId === blockedId);
  if (turn ? !openOrganizer(turn) : blockedId === UNNAMED_ORGANIZER && turns) return [];
  const token = turn && paygResumeToken(turn);
  return [{ id: 'payg-organizer-blocked', tone: 'warning', label: '上一轮整理未完成', text: ORGANIZER_PENDING_NOTICE,
    ...(token ? { actions: [{ label: PAYG_ACTION.resume, disabled: Boolean(ctx.disabled || ctx.resumingId),
      onClick: () => ctx.onResume(token) }] } : {}) }];
}

export type PaygResumeState = { resumingId: string | null; blockedId: string | null; outcomes: Record<string, PaygOutcome> };

/**
 * One page's resumes, without React so the rules are testable. Only one resume runs at a time:
 * a second click, from any turn, does nothing until the first returns. Every resume ends with
 * a re-read of the session, whatever its outcome.
 */
export function paygResumeController(deps: {
  call: (token: PaygResumeToken) => Promise<unknown>;
  refetch: () => Promise<unknown>;
  onChange: (state: PaygResumeState) => void;
}) {
  let state: PaygResumeState = { resumingId: null, blockedId: null, outcomes: {} };
  const set = (next: Partial<PaygResumeState>) => { state = { ...state, ...next }; deps.onChange(state); };
  const settle = (executionId: string, outcome: PaygOutcome | null) => {
    const outcomes = { ...state.outcomes };
    if (outcome) outcomes[executionId] = outcome;
    else delete outcomes[executionId];
    set({ outcomes });
  };
  return {
    state: () => state,
    /** Returns false when another resume is still running and this click was ignored. */
    async resume(token: PaygResumeToken) {
      if (state.resumingId) return false;
      set({ resumingId: token.executionId });
      try {
        settle(token.executionId, resumeOutcome(await deps.call(token)));
      } catch (cause) {
        settle(token.executionId, { kind: 'notice', text: resumeFailureNotice(cause) });
      } finally {
        try { await deps.refetch(); } catch { /* The view's own polling and error notice take over. */ }
        set({ resumingId: null });
      }
      return true;
    },
    /** Records a Q1 refusal of a new message; true when the result was a normal admission. */
    admitted(result: unknown) {
      const blocked = blockedAdmission(result);
      set({ blockedId: blocked?.executionId ?? null });
      return !blocked;
    },
    /** A new message refused by RUNTIME_ORGANIZER_PENDING: the refusal names no turn. */
    block() {
      set({ blockedId: UNNAMED_ORGANIZER });
    },
  };
}
