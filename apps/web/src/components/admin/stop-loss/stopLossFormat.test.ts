/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { describeAlert, formatUsd, parseUsdInput, reachedLimit, stopLossErrorMessage } from './stopLossFormat';

describe('stop-loss amounts', () => {
  it('treats empty as not set and accepts only the server amount format', () => {
    expect(parseUsdInput('  ')).toEqual({ ok: true, value: null });
    expect(parseUsdInput(' 12.5 ')).toEqual({ ok: true, value: '12.5' });
    expect(parseUsdInput('0')).toEqual({ ok: true, value: '0' });
    expect(parseUsdInput('0.000000000001')).toEqual({ ok: true, value: '0.000000000001' });
    for (const bad of ['-1', '01', '1.', '1.0000000000001', '$5', '1e3', 'abc']) {
      expect(parseUsdInput(bad)).toEqual({ ok: false });
    }
  });

  it('compares decimal strings exactly, without float rounding', () => {
    expect(reachedLimit('0.3', '0.1')).toBe(true);
    expect(reachedLimit('0.299999999999', '0.3')).toBe(false);
    expect(reachedLimit('20', '20.000')).toBe(true);
    expect(reachedLimit('0', '0')).toBe(true);
  });

  it('truncates display to four decimals and hides malformed values', () => {
    expect(formatUsd('12.345678')).toBe('$12.3456');
    expect(formatUsd('3.000000')).toBe('$3');
    expect(formatUsd('0')).toBe('$0');
    expect(formatUsd('0.000')).toBe('$0');
    expect(formatUsd('0.000000000001')).toBe('<$0.0001');
    expect(formatUsd('1.00000001')).toBe('$1');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd('-1')).toBe('—');
  });
});

describe('stop-loss errors', () => {
  it('maps codes to Chinese and never shows server text', () => {
    expect(stopLossErrorMessage({ data: { code: 'CONFLICT' } }, 'save')).toContain('已被其他人修改');
    expect(stopLossErrorMessage({ data: { httpStatus: 409 } }, 'save')).toContain('重新读取');
    expect(stopLossErrorMessage({ data: { code: 'FORBIDDEN' } }, 'read')).toBe('只有管理员可以查看和修改成本止损设置。');
    expect(stopLossErrorMessage({ data: { code: 'UNAUTHORIZED' } }, 'read')).toContain('重新登录');
    expect(stopLossErrorMessage({ message: 'RUNTIME_STOP_LOSS_CONFIG_INVALID', data: { code: 'SERVICE_UNAVAILABLE' } }, 'read'))
      .toContain('格式异常');
    const raw = stopLossErrorMessage({ message: 'RUNTIME_STOP_LOSS_UNAVAILABLE relation x', data: null }, 'read');
    expect(raw).toBe('暂时无法读取成本止损信息，请稍后点“重新读取”。');
  });
});

describe('stop-loss alerts', () => {
  const at = '2026-10-11T03:00:00.000Z';
  it('describes each alert type from aggregate fields only', () => {
    expect(describeAlert({ id: '1', test_id: 'runtime_stop_loss_siteDailyUsd', created_at: at,
      details: { utcDate: '2026-10-11', scope: 'site', thresholdUsd: '20', actualUsd: '20.5' } }))
      .toEqual({ title: '全站每日上限已达到', detail: '当天实际 $20.5，上限 $20', day: '2026-10-11（UTC）' });
    const user = describeAlert({ id: '2', test_id: 'runtime_stop_loss_userDailyUsd', created_at: at,
      details: { utcDate: '2026-10-11', scope: 'user', thresholdUsd: '2', actualUsd: '2.1', userId: 'should-not-show' } });
    expect(JSON.stringify(user)).not.toContain('should-not-show');
    expect(user.title).toBe('有用户达到每人每日上限');
    expect(describeAlert({ id: '3', test_id: 'runtime_stop_loss_balance_openrouter_low', created_at: at,
      details: { balanceUsd: '4', thresholdUsd: '5' } }).title).toBe('OpenRouter 余额偏低');
    expect(describeAlert({ id: '4', test_id: 'runtime_stop_loss_balance_tikhub_unknown', created_at: at,
      details: { balanceUsd: null, thresholdUsd: '5' } }).title).toBe('TikHub 余额未知');
    expect(describeAlert({ id: '5', test_id: 'runtime_stop_loss_monitor_unavailable', created_at: at,
      details: { code: 'X' } }).title).toBe('止损检查暂时无法读取设置');
    expect(describeAlert({ id: '6', test_id: 'runtime_stop_loss_other', created_at: at, details: null }).title)
      .toBe('其他止损告警');
  });
});
