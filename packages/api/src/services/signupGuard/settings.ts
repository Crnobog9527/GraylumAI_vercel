/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { z } from 'zod';

/** An empty box must not become 0 ("nobody gets the grant"): only a whole number 0-100000, as a number or digits. */
export function validSignupGiftCap(value: unknown): boolean {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^[0-9]{1,6}$/.test(text) && Number(text) <= 100000;
}

/** BOT-GUARD: the opening grant's daily cap (Beijing day) and pause switch, read by opening_grant_remember in the database. */
export function validateSignupGiftSetting(setting: { key: string; value: unknown }, ctx: z.RefinementCtx) {
  if (setting.key === 'signup_gift_daily_cap' && !validSignupGiftCap(setting.value)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '每日注册赠送上限须为 0 至 100000 的整数' });
  }
  if (setting.key === 'signup_gift_paused' && !([true, false, 'true', 'false'] as unknown[]).includes(setting.value)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '暂停注册赠送只能是开或关' });
  }
}
