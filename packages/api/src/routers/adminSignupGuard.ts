/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure } from '../trpc';
import { recordAdminActivity } from '../services/adminUserAccess';
import { createAdminOperationError, systemSettingsTable } from './adminShared';
import { assertSettingsWriter } from './settings';

/*
 * BOT-GUARD part 3 (Owner 2026-11-13: "这些防刷规则，你最好直接做进我的管理后台功能里面，让我的后台可以直接改"): the admin
 * card «注册赠送防刷». It reads today's count, the three settings and the last days' refusals by reason, and saves the three
 * settings together. The database reads the settings on every claim, so a save takes effect at once. Only an active,
 * non-deleted admin may save (assertSettingsWriter, the same check as every system setting); each save is audited.
 */
export const SIGNUP_GUARD_KEYS = { dailyCap: 'signup_gift_daily_cap', ipLimit: 'signup_gift_ip_limit', paused: 'signup_gift_paused' } as const;

const todaySchema = z.object({ day: z.string(), granted: z.number().int().min(0), cap: z.number().int().min(0),
  paused: z.boolean(), ip_limit: z.number().int().min(1) });
const daySchema = z.object({ day: z.string(), granted: z.number().int().min(0), refused_paused: z.number().int().min(0),
  refused_same_ip: z.number().int().min(0), refused_daily_cap: z.number().int().min(0) });

export const signupGuardInput = z.object({
  dailyCap: z.number().int().min(0).max(100000),
  ipLimit: z.number().int().min(1).max(50),
  paused: z.boolean(),
}).strict();

export const adminSignupGuardProcedures = {
  getSignupGuard: adminProcedure.query(async ({ ctx }) => {
    const [today, recent] = await Promise.all([
      ctx.supabaseAdmin.rpc('signup_gift_today'), ctx.supabaseAdmin.rpc('signup_gift_recent', { p_days: 7 }),
    ]);
    if (today.error || recent.error) throw createAdminOperationError('读取注册赠送防刷', today.error ?? recent.error);
    const t = todaySchema.safeParse(today.data), r = z.array(daySchema).safeParse(recent.data);
    if (!t.success || !r.success) throw createAdminOperationError('读取注册赠送防刷', new Error('signup gift shape'));
    const refused = (key: 'refused_paused' | 'refused_same_ip' | 'refused_daily_cap') => ({
      today: r.data[0]?.[key] ?? 0, last7Days: r.data.reduce((sum, day) => sum + day[key], 0),
    });
    return {
      day: t.data.day, granted: t.data.granted,
      settings: { dailyCap: t.data.cap, ipLimit: t.data.ip_limit, paused: t.data.paused },
      refused: { paused: refused('refused_paused'), sameIp: refused('refused_same_ip'), dailyCap: refused('refused_daily_cap') },
      days: r.data,
    };
  }),

  updateSignupGuard: adminProcedure.input(signupGuardInput).mutation(async ({ ctx, input }) => {
    await assertSettingsWriter(ctx.supabase, ctx.profileId);
    const before = await ctx.supabaseAdmin.rpc('signup_gift_today');
    const previous = todaySchema.safeParse(before.data);
    const rows = [
      { key: SIGNUP_GUARD_KEYS.dailyCap, value: input.dailyCap },
      { key: SIGNUP_GUARD_KEYS.ipLimit, value: input.ipLimit },
      { key: SIGNUP_GUARD_KEYS.paused, value: input.paused },
    ];
    const { error } = await systemSettingsTable(ctx.supabase).upsert(rows, { onConflict: 'key' });
    if (error) {
      if (error.code === '42501') throw new TRPCError({ code: 'FORBIDDEN', message: '当前账号无权修改系统设置' });
      throw createAdminOperationError('保存注册赠送防刷', error);
    }
    const from = previous.success ? { dailyCap: previous.data.cap, ipLimit: previous.data.ip_limit, paused: previous.data.paused } : null;
    const auditRecorded = await recordAdminActivity(ctx.supabase, {
      user_id: ctx.profileId, admin_id: ctx.profileId, action_type: 'signup_gift_settings',
      action: `注册赠送防刷：每日上限 ${input.dailyCap}，同一网络 24 小时 ${input.ipLimit} 个，${input.paused ? '已暂停' : '未暂停'}`,
      details: { from, to: input },
    });
    return { ok: true as const, auditRecorded };
  }),
};
