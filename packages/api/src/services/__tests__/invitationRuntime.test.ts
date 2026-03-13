/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateInvitationClaimDecision,
  getClientIp,
  getChinaDayStartIso,
  getChinaMonthStartIso,
  getOneHourAgoIso,
} from '../invitationRuntime';

describe('getClientIp', () => {
  it('prefers the first forwarded IP when multiple proxies are present', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.1, 198.51.100.2',
      'x-real-ip': '198.51.100.9',
    });

    expect(getClientIp(headers)).toBe('203.0.113.1');
  });

  it('falls back to x-real-ip when forwarded headers are absent', () => {
    const headers = new Headers({
      'x-real-ip': '198.51.100.9',
    });

    expect(getClientIp(headers)).toBe('198.51.100.9');
  });
});

describe('evaluateInvitationClaimDecision', () => {
  const baseSettings = {
    inviterReward: 50,
    inviteeReward: 30,
    newUserCredits: 100,
    dailyRewardLimit: 1000,
    monthlyCountLimit: 50,
    totalRewardLimit: 50000,
    sameIpHourLimit: 3,
    sameIpDayLimit: 5,
    riskAutoReject: true,
  } as const;

  it('rejects high-risk same-IP claims when auto reject is enabled', () => {
    const decision = evaluateInvitationClaimDecision({
      settings: baseSettings,
      metrics: {
        inviterRewardedToday: 0,
        inviterRewardedTotal: 0,
        rewardedInvitesThisMonth: 0,
        sameIpClaimsLastHour: 3,
        sameIpClaimsToday: 4,
      },
      ipAddress: '203.0.113.1',
    });

    expect(decision).toEqual({
      status: 'rejected',
      riskLevel: 'high',
      blockReason: '同一 IP 在 1 小时内已达到 3 次注册上限',
      inviterRewardGranted: 0,
      inviteeRewardGranted: 0,
    });
  });

  it('clips inviter reward to the remaining daily allowance instead of ignoring the cap', () => {
    const decision = evaluateInvitationClaimDecision({
      settings: {
        ...baseSettings,
        dailyRewardLimit: 100,
      },
      metrics: {
        inviterRewardedToday: 90,
        inviterRewardedTotal: 0,
        rewardedInvitesThisMonth: 1,
        sameIpClaimsLastHour: 0,
        sameIpClaimsToday: 0,
      },
      ipAddress: '203.0.113.1',
    });

    expect(decision).toEqual({
      status: 'rewarded',
      riskLevel: 'low',
      blockReason: null,
      inviterRewardGranted: 10,
      inviteeRewardGranted: 30,
    });
  });

  it('rejects further rewards once the monthly effective invite limit is reached', () => {
    const decision = evaluateInvitationClaimDecision({
      settings: {
        ...baseSettings,
        monthlyCountLimit: 2,
      },
      metrics: {
        inviterRewardedToday: 0,
        inviterRewardedTotal: 0,
        rewardedInvitesThisMonth: 2,
        sameIpClaimsLastHour: 0,
        sameIpClaimsToday: 0,
      },
      ipAddress: '203.0.113.1',
    });

    expect(decision).toEqual({
      status: 'rejected',
      riskLevel: 'medium',
      blockReason: '邀请人本月有效邀请人数已达到 2 人上限',
      inviterRewardGranted: 0,
      inviteeRewardGranted: 0,
    });
  });

  it('keeps the claim rewardable when a high-risk IP is observed but auto reject is disabled', () => {
    const decision = evaluateInvitationClaimDecision({
      settings: {
        ...baseSettings,
        riskAutoReject: false,
      },
      metrics: {
        inviterRewardedToday: 0,
        inviterRewardedTotal: 0,
        rewardedInvitesThisMonth: 0,
        sameIpClaimsLastHour: 5,
        sameIpClaimsToday: 8,
      },
      ipAddress: '203.0.113.1',
    });

    expect(decision).toEqual({
      status: 'rewarded',
      riskLevel: 'high',
      blockReason: null,
      inviterRewardGranted: 50,
      inviteeRewardGranted: 30,
    });
  });
});

describe('invitation period helpers', () => {
  it('computes China-local day and month boundaries while keeping rolling one-hour windows in UTC', () => {
    const now = new Date('2026-03-10T02:30:00.000Z');

    expect(getChinaDayStartIso(now)).toBe('2026-03-09T16:00:00.000Z');
    expect(getChinaMonthStartIso(now)).toBe('2026-02-28T16:00:00.000Z');
    expect(getOneHourAgoIso(now)).toBe('2026-03-10T01:30:00.000Z');
  });
});
