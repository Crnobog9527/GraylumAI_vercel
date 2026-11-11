import { describe, expect, it } from 'vitest';
import {
  buildErasureImpactLines, describeErasureError, erasureBlocked, isAccountClosedError, isRenewalBlockedError,
  renewalUsesStripePortal,
} from './account-erasure';

const base = {
  credits: 40,
  subscriptionRenewing: false,
  subscriptionActiveUntil: null,
  pendingPayments: 0,
  runsInFlight: 0,
  closed: false,
};

describe('buildErasureImpactLines', () => {
  it('states only the consequences of confirming, never refund rules', () => {
    const text = buildErasureImpactLines(base).map((line) => line.text).join('\n');
    expect(text).toContain('不能撤销');
    expect(text).toContain('剩余 40 积分将作废');
    expect(text).toContain('私有内容将被清除');
    expect(text).toContain('3 年');
    expect(text).not.toMatch(/退款|手续费|工单/);
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

  it('blocks while a refund request is being handled (Owner 2026-11-11), and lets the user go on once it is done', () => {
    const open = { ...base, refundRequestOpen: true };
    expect(buildErasureImpactLines(open)[0]).toEqual({ tone: 'block', text: '你有一笔退款申请在处理中，处理完成后才能注销。' });
    expect(erasureBlocked(open)).toBe(true);
    expect(erasureBlocked({ ...base, refundRequestOpen: false })).toBe(false);
    // A server without the field (before migration 9999) is read as no request.
    expect(erasureBlocked(base)).toBe(false);
    expect(erasureBlocked({ ...base, subscriptionRenewing: true })).toBe(true);
  });

  it('points card renewals without a Stripe portal to support, and keeps the portal for legacy Stripe', () => {
    const card = { ...base, subscriptionRenewing: true, renewalChannels: ['waffo'] };
    const lines = buildErasureImpactLines(card).filter((line) => line.tone === 'block');
    expect(lines.map((line) => line.text)).toEqual(['你有银行卡自动续费，目前需联系客服停止续费后，才能申请注销。']);
    expect(renewalUsesStripePortal(card)).toBe(false);

    const both = { ...base, subscriptionRenewing: true, renewalChannels: ['stripe_portal', 'stripe'] };
    expect(buildErasureImpactLines(both).filter((line) => line.tone === 'block')).toHaveLength(2);
    expect(renewalUsesStripePortal(both)).toBe(true);
    expect(renewalUsesStripePortal({ ...base, subscriptionRenewing: true })).toBe(true);
  });
});

describe('describeErasureError', () => {
  it('maps server codes to user text and never echoes unknown messages', () => {
    expect(describeErasureError({ message: 'ACCOUNT_ERASURE_REAUTH_REQUIRED: x' })).toContain('重新验证');
    expect(describeErasureError({ message: 'ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING: x' })).toContain('取消自动续费');
    expect(describeErasureError({ message: 'ACCOUNT_ERASURE_REFUND_PENDING: x' })).toBe('你有一笔退款申请在处理中，处理完成后才能注销。');
    expect(describeErasureError({ message: 'relation profiles does not exist' })).toBe('注销暂时无法完成，请稍后重试。');
    expect(describeErasureError({ message: 'x', data: { code: 'TOO_MANY_REQUESTS' } })).toContain('频繁');
    expect(isAccountClosedError({ message: 'ACCOUNT_CLOSED: 账号已注销' })).toBe(true);
    expect(isRenewalBlockedError({ message: 'ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING: x' })).toBe(true);
    expect(isRenewalBlockedError({ message: 'ACCOUNT_ERASURE_ADMIN_DENIED: x' })).toBe(false);
  });
});
