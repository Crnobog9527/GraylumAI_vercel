/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { dedupeKey, RULES, type OwnerAlertFacts, type OwnerAlertKind } from './kinds';
import { money, renderAlert, sanitize } from './templates';

/** One example per kind: the PR lists their rendered text (ALERT-FEISHU done item 9). */
const EXAMPLES: { [K in OwnerAlertKind]: OwnerAlertFacts[K] } = {
  payment_webhook_failed: { provider: 'stripe', eventId: 'evt_1', eventType: 'invoice.paid', code: 'PAY_STRIPE_MP_RENEWAL_UNAVAILABLE' },
  payment_webhook_unavailable: { provider: 'stripe', reason: 'signature' },
  payment_webhook_unclaimed: { provider: 'stripe', eventId: 'evt_1', eventType: 'customer.subscription.deleted' },
  refund: { orderId: '6f1c2a9e-1111-4c3b-9d1e-000000000000', refundId: 're_1', orderKind: 'subscription_first', state: 'refunded',
    refundedMinor: 6900, chargedMinor: 6900, currency: 'usd', creditsTakenBack: 5200, creditsShortfall: 1700 },
  dispute: { code: 'PAY_DISPUTE_OPENED', disputeId: 'd-1', dueBy: '2026-11-20T23:59:59Z' },
  billing_review: { code: 'PAY_STRIPE_MP_RECONCILIATION_REVIEW_REQUIRED', count: 2 },
  stop_loss: { alertId: '42', line: '全站成本提醒线已达到：当天实际 $41.20，提醒线 $40（统计日 2026-11-08 UTC）' },
  stop_loss_reached: { utcDate: '2026-11-08' },
  provider_402: { provider: 'openrouter' },
  model_blocked: { modelId: '00000000-0000-4000-8000-000000000020' },
  platform_absorb: { model: 'anthropic/claude-sonnet-5.5', utcDate: '2026-11-07', usd: '12.304000000000', thresholdUsd: '10' },
  ops_backlog: { code: 'ERASURE_BACKLOG', level: 'error' },
  error_spike: { count: 23, minutes: 10 },
  test: { note: '这是一条测试消息，收到说明 staging 的两个变量配好了。' },
};

const ctx = { origin: 'https://www.graylum.com', testSite: false };
const FORBIDDEN = [/@/, /https?:\/\/(?!www\.graylum\.com\/admin)/, /\b(?:sk|whsec|sntrys)_/, /\b[A-Z]{2,}_[A-Z_]{3,}\b/];

describe('renderAlert', () => {
  it('renders every kind as plain sentences under a 【tag】, then 「去后台看：」 and an admin link', () => {
    for (const kind of Object.keys(RULES) as OwnerAlertKind[]) {
      const text = renderAlert(kind, EXAMPLES[kind] as never, ctx);
      const [line, link, ...rest] = text.split('\n');
      expect(rest, kind).toEqual([]);
      expect(line, kind).toMatch(/^【[^】]+】\S/);
      expect(link, kind).toMatch(/^去后台看：https:\/\/www\.graylum\.com\/admin(\/[a-z-]+)*$/);
      // No code-like words, addresses or keys in what the Owner reads.
      for (const pattern of FORBIDDEN) expect(line, `${kind} ${pattern}`).not.toMatch(pattern);
    }
  });

  it('words a refund with its amounts and the credits taken back or still missing', () => {
    expect(renderAlert('refund', EXAMPLES.refund, ctx).split('\n')[0]).toBe(
      '【退款】会员订单 6f1c2a9e 在 Stripe 那边退了 $69.00（不是从后台发起的），已自动扣回 5200 积分，还差 1700 积分没扣回（已经被用掉）。');
    expect(renderAlert('refund', { ...EXAMPLES.refund, state: 'partial_review', refundedMinor: 2000 }, ctx))
      .toContain('只退了一部分（$20.00）');
    expect(renderAlert('refund', { ...EXAMPLES.refund, creditsTakenBack: 0, creditsShortfall: 0 }, ctx)).toContain('没有要扣回的积分');
    // Unknown (a replay) is never worded as zero.
    const unknown = renderAlert('refund', { ...EXAMPLES.refund, creditsTakenBack: null, creditsShortfall: null }, ctx);
    expect(unknown).toContain('积分扣回情况请到后台看');
    expect(unknown).not.toContain('没有要扣回');
  });

  it('tells the Owner a model is off for everyone, where to check it and what to click', () => {
    const [line, link] = renderAlert('model_blocked', EXAMPLES.model_blocked, ctx).split('\n');
    expect(line).toMatch(/^【模型已暂停】/);
    expect(line).toContain('暂停所有用户对这个模型的新调用');
    expect(line).toContain('系统设置 → 成本止损');
    expect(line).toContain('已核对价格，恢复调用');
    expect(link).toBe('去后台看：https://www.graylum.com/admin/settings');
  });

  it('gives an unknown code a plain fallback instead of the code', () => {
    expect(renderAlert('dispute', { code: 'PAY_DISPUTE_SOMETHING_NEW', disputeId: 'x', dueBy: null }, ctx))
      .toContain('有一笔拒付有新情况');
    expect(renderAlert('billing_review', { code: 'PAY_NEW_THING', count: null }, ctx)).toContain('一项付款检查需要人工处理');
    expect(renderAlert('ops_backlog', { code: 'X', level: 'fatal' }, ctx)).toMatch(/^【紧急】/);
  });

  it('marks every site but production', () => {
    expect(renderAlert('test', EXAMPLES.test, { origin: 'https://staging.graylum.com', testSite: true }))
      .toMatch(/^（测试站）【测试】.*\n去后台看：https:\/\/staging\.graylum\.com\/admin$/);
  });
});

describe('sanitize', () => {
  it('removes full emails, phone numbers, keys and hook addresses whatever a caller passes', () => {
    // Built at run time, so no key-shaped literal is committed (the secret scan rejects one, even a fake).
    const fakeKey = ['sk', 'live', 'abcdefgh123'].join('_');
    const text = sanitize(`a.b+c@gmail.com +1 415 555 0100 ${fakeKey} https://open.feishu.cn/open-apis/bot/v2/hook/x`);
    expect(text).toBe('[邮箱] [号码] [已隐藏] [已隐藏]');
    expect(renderAlert('stop_loss', { alertId: '1', line: '联系 owner@graylum.com' }, ctx)).not.toContain('@');
  });

  it('leaves amounts and dates alone', () => {
    expect(sanitize('$1234.50 2026-11-08 6900 积分')).toBe('$1234.50 2026-11-08 6900 积分');
  });
});

describe('dedupeKey', () => {
  it('keys events by the event and conditions by the condition, safe for Redis', () => {
    const now = new Date('2026-11-08T10:30:00Z');
    expect(dedupeKey('refund', EXAMPLES.refund, now)).toBe('refund:refunded:6f1c2a9e-1111-4c3b-9d1e-000000000000:re_1');
    expect(dedupeKey('billing_review', EXAMPLES.billing_review, now)).toBe('billing_review:PAY_STRIPE_MP_RECONCILIATION_REVIEW_REQUIRED:2026-11-08');
    expect(dedupeKey('error_spike', EXAMPLES.error_spike, now)).toBe('error_spike:site');
    // A condition per model: the same model is one message a window, another model is its own.
    expect(dedupeKey('model_blocked', EXAMPLES.model_blocked, now)).toBe('model_blocked:00000000-0000-4000-8000-000000000020');
    expect(RULES.model_blocked.ttlSeconds).toBe(3600);
    expect(dedupeKey('platform_absorb', EXAMPLES.platform_absorb, now)).toBe('platform_absorb:anthropic_claude-sonnet-5.5:2026-11-07');
    expect(money(123456, 'eur')).toBe('1234.56 EUR');
  });
});
