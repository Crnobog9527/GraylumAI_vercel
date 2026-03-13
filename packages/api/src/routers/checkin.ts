/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { TRPCError } from '@trpc/server';

import { protectedProcedure, router } from '../trpc';

const CHECKIN_DEFAULT_REWARDS: Record<number, number> = {
  1: 5,
  2: 10,
  3: 15,
  4: 20,
  5: 25,
};

function getChinaDateKey(offsetDays = 0) {
  const chinaNow = new Date(Date.now() + 8 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  const year = chinaNow.getUTCFullYear();
  const month = `${chinaNow.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${chinaNow.getUTCDate()}`.padStart(2, '0');

  return {
    dateKey: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
  };
}

function parseIntegerSetting(value: unknown, fallback: number) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }

  return fallback;
}

async function loadCheckinSettings(supabase: any) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('key, value')
    .in('key', [
      'checkin_day1',
      'checkin_day2',
      'checkin_day3',
      'checkin_day4',
      'checkin_day5',
      'checkin_monthly_bonus',
    ]);

  if (error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取签到配置失败',
      cause: error,
    });
  }

  const settingsMap = new Map<string, unknown>((data ?? []).map((item: { key: string; value: unknown }) => [item.key, item.value]));

  return {
    cycleRewards: {
      1: parseIntegerSetting(settingsMap.get('checkin_day1'), CHECKIN_DEFAULT_REWARDS[1]),
      2: parseIntegerSetting(settingsMap.get('checkin_day2'), CHECKIN_DEFAULT_REWARDS[2]),
      3: parseIntegerSetting(settingsMap.get('checkin_day3'), CHECKIN_DEFAULT_REWARDS[3]),
      4: parseIntegerSetting(settingsMap.get('checkin_day4'), CHECKIN_DEFAULT_REWARDS[4]),
      5: parseIntegerSetting(settingsMap.get('checkin_day5'), CHECKIN_DEFAULT_REWARDS[5]),
    } as Record<number, number>,
    monthlyBonusCredits: parseIntegerSetting(settingsMap.get('checkin_monthly_bonus'), 50),
  };
}

export const checkinRouter = router({
  getCheckinStatus: protectedProcedure.query(async ({ ctx }) => {
    const { dateKey: todayKey, monthKey } = getChinaDateKey();
    const { dateKey: yesterdayKey } = getChinaDateKey(-1);
    const { cycleRewards, monthlyBonusCredits } = await loadCheckinSettings(ctx.supabase);

    const [{ data: todayRecord, error: todayError }, { data: recentRecords, error: recentError }, { count: monthCount, error: monthCountError }] =
      await Promise.all([
        ctx.supabase
          .from('user_checkins')
          .select('checkin_date, streak_day, reward_credits, monthly_bonus_credits')
          .eq('user_id', ctx.profileId)
          .eq('checkin_date', todayKey)
          .maybeSingle(),
        ctx.supabase
          .from('user_checkins')
          .select('checkin_date, streak_day, reward_credits, monthly_bonus_credits')
          .eq('user_id', ctx.profileId)
          .order('checkin_date', { ascending: false })
          .limit(10),
        ctx.supabase
          .from('user_checkins')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', ctx.profileId)
          .eq('month_key', monthKey),
      ]);

    if (todayError || recentError || monthCountError) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '读取签到状态失败',
        cause: todayError ?? recentError ?? monthCountError,
      });
    }

    const hasCheckedInToday = Boolean(todayRecord);
    const yesterdayRecord = (recentRecords ?? []).find((record: any) => record.checkin_date === yesterdayKey);
    const referenceDay = todayRecord?.streak_day ?? yesterdayRecord?.streak_day ?? 0;
    const nextCycleDay = referenceDay > 0 ? (referenceDay >= 5 ? 1 : referenceDay + 1) : 1;
    const todayRewardCredits = (todayRecord?.reward_credits ?? 0) + (todayRecord?.monthly_bonus_credits ?? 0);
    const currentMonthCount = monthCount ?? 0;

    return {
      hasCheckedInToday,
      todayKey,
      currentCycleDay: todayRecord?.streak_day ?? (yesterdayRecord ? (yesterdayRecord.streak_day >= 5 ? 1 : yesterdayRecord.streak_day + 1) : 1),
      nextCycleDay,
      todayRewardCredits,
      nextRewardCredits: cycleRewards[nextCycleDay],
      cycleRewards,
      monthlyCheckinCount: currentMonthCount,
      monthlyBonusCredits,
      daysUntilMonthlyBonus: Math.max(0, 30 - currentMonthCount),
      recentCheckins: (recentRecords ?? []).map((record: any) => ({
        checkinDate: record.checkin_date,
        streakDay: record.streak_day,
        rewardCredits: record.reward_credits,
        monthlyBonusCredits: record.monthly_bonus_credits,
      })),
    };
  }),

  claimDailyCheckin: protectedProcedure.mutation(async ({ ctx }) => {
    const { data, error } = await ctx.supabase.rpc('claim_daily_checkin', {
      p_user_id: ctx.profileId,
    });

    if (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '签到失败，请稍后重试',
        cause: error,
      });
    }

    const result = Array.isArray(data) ? data[0] : data;

    if (!result) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '签到结果为空，请稍后重试',
      });
    }

    return {
      alreadyClaimed: Boolean(result.already_claimed),
      checkinDate: result.checkin_date as string,
      streakDay: Number(result.streak_day ?? 1),
      rewardCredits: Number(result.reward_credits ?? 0),
      monthlyBonusCredits: Number(result.monthly_bonus_credits ?? 0),
      totalReward: Number(result.total_reward_credits ?? 0),
      monthlyCheckinCount: Number(result.monthly_checkin_count ?? 0),
    };
  }),
});
