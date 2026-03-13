/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { TRPCError } from '@trpc/server';

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

const DEFAULT_INVITATION_SETTINGS = {
  inviterReward: 50,
  inviteeReward: 30,
  newUserCredits: 100,
  rebatePercent: 5,
  bindingDays: 30,
  dailyRewardLimit: 1000,
  monthlyCountLimit: 50,
  totalRewardLimit: 50000,
  sameIpHourLimit: 3,
  sameIpDayLimit: 5,
  riskAutoReject: true,
} as const;

const INVITATION_SETTING_KEYS = [
  'invite_inviter_reward',
  'invite_invitee_reward',
  'new_user_credits',
  'invite_rebate_percent',
  'invite_binding_days',
  'invite_daily_reward_limit',
  'invite_monthly_count_limit',
  'invite_total_reward_limit',
  'invite_same_ip_hour_limit',
  'invite_same_ip_day_limit',
  'invite_risk_auto_reject',
] as const;

export interface InvitationRuntimeSettings {
  inviterReward: number;
  inviteeReward: number;
  newUserCredits: number;
  rebatePercent: number;
  bindingDays: number;
  dailyRewardLimit: number;
  monthlyCountLimit: number;
  totalRewardLimit: number;
  sameIpHourLimit: number;
  sameIpDayLimit: number;
  riskAutoReject: boolean;
}

export interface InvitationClaimMetrics {
  inviterRewardedToday: number;
  inviterRewardedTotal: number;
  rewardedInvitesThisMonth: number;
  sameIpClaimsLastHour: number;
  sameIpClaimsToday: number;
}

export interface InvitationClaimDecision {
  status: 'rewarded' | 'rejected';
  riskLevel: 'low' | 'medium' | 'high';
  blockReason: string | null;
  inviterRewardGranted: number;
  inviteeRewardGranted: number;
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

function parseBooleanSetting(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return fallback;
}

function getChinaDateParts(now: Date) {
  const shifted = new Date(now.getTime() + CHINA_OFFSET_MS);

  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

export function getChinaDayStartIso(now: Date = new Date()) {
  const { year, monthIndex, day } = getChinaDateParts(now);
  return new Date(Date.UTC(year, monthIndex, day) - CHINA_OFFSET_MS).toISOString();
}

export function getChinaMonthStartIso(now: Date = new Date()) {
  const { year, monthIndex } = getChinaDateParts(now);
  return new Date(Date.UTC(year, monthIndex, 1) - CHINA_OFFSET_MS).toISOString();
}

export function getOneHourAgoIso(now: Date = new Date()) {
  return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
}

export function getBindingCutoffIso(bindingDays: number, now: Date = new Date()) {
  return new Date(now.getTime() - Math.max(0, bindingDays) * 24 * 60 * 60 * 1000).toISOString();
}

export function getClientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const firstIp = forwarded.split(',')[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  const cfConnectingIp = headers.get('cf-connecting-ip')?.trim();
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) {
    return realIp;
  }

  return null;
}

export async function loadInvitationRuntimeSettings(supabase: any): Promise<InvitationRuntimeSettings> {
  const { data, error } = await supabase
    .from('system_settings')
    .select('key, value')
    .in('key', [...INVITATION_SETTING_KEYS]);

  if (error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取邀请配置失败',
      cause: error,
    });
  }

  const settingsMap = new Map<string, unknown>((data ?? []).map((item: { key: string; value: unknown }) => [item.key, item.value]));

  return {
    inviterReward: parseIntegerSetting(settingsMap.get('invite_inviter_reward'), DEFAULT_INVITATION_SETTINGS.inviterReward),
    inviteeReward: parseIntegerSetting(settingsMap.get('invite_invitee_reward'), DEFAULT_INVITATION_SETTINGS.inviteeReward),
    newUserCredits: parseIntegerSetting(settingsMap.get('new_user_credits'), DEFAULT_INVITATION_SETTINGS.newUserCredits),
    rebatePercent: parseIntegerSetting(settingsMap.get('invite_rebate_percent'), DEFAULT_INVITATION_SETTINGS.rebatePercent),
    bindingDays: parseIntegerSetting(settingsMap.get('invite_binding_days'), DEFAULT_INVITATION_SETTINGS.bindingDays),
    dailyRewardLimit: parseIntegerSetting(settingsMap.get('invite_daily_reward_limit'), DEFAULT_INVITATION_SETTINGS.dailyRewardLimit),
    monthlyCountLimit: parseIntegerSetting(settingsMap.get('invite_monthly_count_limit'), DEFAULT_INVITATION_SETTINGS.monthlyCountLimit),
    totalRewardLimit: parseIntegerSetting(settingsMap.get('invite_total_reward_limit'), DEFAULT_INVITATION_SETTINGS.totalRewardLimit),
    sameIpHourLimit: parseIntegerSetting(settingsMap.get('invite_same_ip_hour_limit'), DEFAULT_INVITATION_SETTINGS.sameIpHourLimit),
    sameIpDayLimit: parseIntegerSetting(settingsMap.get('invite_same_ip_day_limit'), DEFAULT_INVITATION_SETTINGS.sameIpDayLimit),
    riskAutoReject: parseBooleanSetting(settingsMap.get('invite_risk_auto_reject'), DEFAULT_INVITATION_SETTINGS.riskAutoReject),
  };
}

export function evaluateInvitationClaimDecision(args: {
  settings: InvitationRuntimeSettings;
  metrics: InvitationClaimMetrics;
  ipAddress?: string | null;
}): InvitationClaimDecision {
  const { settings, metrics, ipAddress } = args;

  const highRiskReasons: string[] = [];

  if (ipAddress) {
    if (settings.sameIpHourLimit > 0 && metrics.sameIpClaimsLastHour >= settings.sameIpHourLimit) {
      highRiskReasons.push(`同一 IP 在 1 小时内已达到 ${settings.sameIpHourLimit} 次注册上限`);
    }

    if (settings.sameIpDayLimit > 0 && metrics.sameIpClaimsToday >= settings.sameIpDayLimit) {
      highRiskReasons.push(`同一 IP 在当日已达到 ${settings.sameIpDayLimit} 次注册上限`);
    }
  }

  if (highRiskReasons.length > 0 && settings.riskAutoReject) {
    return {
      status: 'rejected',
      riskLevel: 'high',
      blockReason: highRiskReasons.join('；'),
      inviterRewardGranted: 0,
      inviteeRewardGranted: 0,
    };
  }

  if (settings.monthlyCountLimit > 0 && metrics.rewardedInvitesThisMonth >= settings.monthlyCountLimit) {
    return {
      status: 'rejected',
      riskLevel: 'medium',
      blockReason: `邀请人本月有效邀请人数已达到 ${settings.monthlyCountLimit} 人上限`,
      inviterRewardGranted: 0,
      inviteeRewardGranted: 0,
    };
  }

  let inviterRewardGranted = settings.inviterReward;

  if (settings.dailyRewardLimit > 0) {
    const remainingDailyReward = Math.max(0, settings.dailyRewardLimit - metrics.inviterRewardedToday);
    inviterRewardGranted = Math.min(inviterRewardGranted, remainingDailyReward);
  }

  if (settings.totalRewardLimit > 0) {
    const remainingTotalReward = Math.max(0, settings.totalRewardLimit - metrics.inviterRewardedTotal);
    inviterRewardGranted = Math.min(inviterRewardGranted, remainingTotalReward);
  }

  return {
    status: 'rewarded',
    riskLevel: highRiskReasons.length > 0 ? 'high' : 'low',
    blockReason: null,
    inviterRewardGranted,
    inviteeRewardGranted: settings.inviteeReward,
  };
}
