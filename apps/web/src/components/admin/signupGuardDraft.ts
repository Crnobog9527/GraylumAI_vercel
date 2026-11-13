/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** BOT-GUARD: the admin card's form, as typed text, and the save it becomes (same ranges as the server). */
export type SignupGuardSettings = { dailyCap: number; ipLimit: number; paused: boolean };
export type SignupGuardDraft = { dailyCap: string; ipLimit: string; paused: boolean };

export const draftFrom = (s: SignupGuardSettings): SignupGuardDraft =>
  ({ dailyCap: String(s.dailyCap), ipLimit: String(s.ipLimit), paused: s.paused });

/** The save, or the line to show. An empty box is never read as 0. */
export function parseSignupGuardDraft(draft: SignupGuardDraft):
  { ok: true; value: SignupGuardSettings } | { ok: false; message: string } {
  const cap = draft.dailyCap.trim(), ip = draft.ipLimit.trim();
  if (!/^[0-9]{1,6}$/.test(cap) || Number(cap) > 100000) return { ok: false, message: '每日赠送上限请填 0 到 100000 的整数。' };
  if (!/^[0-9]{1,2}$/.test(ip) || Number(ip) < 1 || Number(ip) > 50) {
    return { ok: false, message: '同一网络 24 小时上限请填 1 到 50 的整数。' };
  }
  return { ok: true, value: { dailyCap: Number(cap), ipLimit: Number(ip), paused: draft.paused } };
}

/** Saving with the pause newly on asks first: accounts created while paused never get the grant later. */
export const needsPauseConfirm = (saved: SignupGuardSettings, next: SignupGuardSettings) => next.paused && !saved.paused;
export const PAUSE_CONFIRM_TEXT = '确定暂停注册赠送？暂停期间注册的新账号一律不送开户积分，以后也不补发。';
