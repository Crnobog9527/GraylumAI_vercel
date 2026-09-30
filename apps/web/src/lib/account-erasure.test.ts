import { describe, expect, it } from 'vitest';
import { buildErasureImpactLines, describeErasureError, isAccountClosedError } from './account-erasure';

const base = {
  credits: 40,
  subscriptionRenewing: false,
  subscriptionActiveUntil: null,
  pendingPayments: 0,
  runsInFlight: 0,
  closed: false,
};

describe('buildErasureImpactLines', () => {
  it('states irreversibility, credit forfeiture, default no-refund and financial retention', () => {
    const text = buildErasureImpactLines(base).map((line) => line.text).join('\n');
    expect(text).toContain('不能撤销');
    expect(text).toContain('剩余 40 积分将作废');
    expect(text).toContain('默认不退款');
    expect(text).toContain('3 年');
    expect(buildErasureImpactLines(base).some((line) => line.tone === 'block')).toBe(false);
  });

  it('blocks first when a subscription still renews and lists money in flight', () => {
    const lines = buildErasureImpactLines({
      ...base, subscriptionRenewing: true, subscriptionActiveUntil: '2026-10-30T00:00:00Z',
      pendingPayments: 2, runsInFlight: 1,
    });
    expect(lines[0]).toMatchObject({ tone: 'block' });
    expect(lines[0].text).toContain('取消自动续费');
    const text = lines.map((line) => line.text).join('\n');
    expect(text).toContain('剩余权益随注销失效');
    expect(text).toContain('2 笔付款');
    expect(text).toContain('1 个 AI 任务');
  });
});

describe('describeErasureError', () => {
  it('maps server codes to user text and never echoes unknown messages', () => {
    expect(describeErasureError({ message: 'ACCOUNT_ERASURE_REAUTH_REQUIRED: x' })).toContain('重新验证');
    expect(describeErasureError({ message: 'ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING: x' })).toContain('取消自动续费');
    expect(describeErasureError({ message: 'relation profiles does not exist' })).toBe('注销暂时无法完成，请稍后重试。');
    expect(describeErasureError({ message: 'x', data: { code: 'TOO_MANY_REQUESTS' } })).toContain('频繁');
    expect(isAccountClosedError({ message: 'ACCOUNT_CLOSED: 账号已注销' })).toBe(true);
  });
});
