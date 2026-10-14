/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_COPY, founderSeatsLeft, METHOD_COPY, cardMethods, checkoutEntryOpen, describeCheckoutError, isStripeCheckoutUrl,
  type MethodMembershipEntry,
} from './methodCheckout';

const entry = (patch: Partial<MethodMembershipEntry> = {}): MethodMembershipEntry => ({
  checkoutReady: true, termsVersion: 'terms-2026-10', goldFirstMonthEligible: true,
  routes: { version: 7, card: { enabled: true }, card_cn: { enabled: true } }, ...patch,
});
const trpcError = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

describe('purchase entry', () => {
  it('opens only when the server says card checkout is ready and a terms version is published', () => {
    expect(checkoutEntryOpen(entry())).toBe(true);
    expect(checkoutEntryOpen(entry({ checkoutReady: false }))).toBe(false);
    expect(checkoutEntryOpen(entry({ termsVersion: null }))).toBe(false);
    expect(checkoutEntryOpen(entry({ termsVersion: '' }))).toBe(false);
    expect(checkoutEntryOpen(entry({ routes: null }))).toBe(false);
    expect(checkoutEntryOpen(undefined)).toBe(false);
  });
  it('offers the mainland card for memberships only, and only switched-on methods', () => {
    expect(cardMethods(entry(), 'membership_plan')).toEqual(['card', 'card_cn']);
    expect(cardMethods(entry(), 'credit_package')).toEqual(['card']);
    expect(cardMethods(entry({ routes: { version: 7, card: { enabled: true } } }), 'membership_plan')).toEqual(['card']);
    expect(cardMethods(entry({ routes: { version: 7, card: { enabled: false }, card_cn: { enabled: true } } }), 'membership_plan'))
      .toEqual(['card_cn']);
    expect(cardMethods(entry({ termsVersion: null }), 'membership_plan')).toEqual([]);
  });
  it('writes the tax rule beside the price without any tax amount', () => {
    expect(METHOD_COPY.card.tax).toBe('税另计，结账时按所在地计算');
    expect(METHOD_COPY.card_cn.tax).toBe('不另收税');
    expect(METHOD_COPY.card_cn.note).toBe('仅限中国大陆用户');
    expect(Object.values(METHOD_COPY).map(item => item.tax).join()).not.toMatch(/\d|%|预计/);
  });
});

describe('return URL', () => {
  it('follows only an https checkout.stripe.com page', () => {
    expect(isStripeCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test_a1#frag')).toBe(true);
    for (const url of ['http://checkout.stripe.com/c/pay/cs', 'https://checkout.stripe.com.evil.test/c', 'https://evil.test/?checkout.stripe.com',
      'https://user@checkout.stripe.com/c', 'https://checkout.stripe.com:8443/c', 'javascript:alert(1)', '/profile', '', null, 42]) {
      expect(isStripeCheckoutUrl(url)).toBe(false);
    }
  });
});

describe('refusals', () => {
  it('shows business refusals in the server words', () => {
    for (const [code, message] of [
      ['PRECONDITION_FAILED', '你已有生效中的会员，不能重复购买。会员到期前无需再次付款。'],
      ['PRECONDITION_FAILED', '积分加油包仅限会员购买。'],
      ['CONFLICT', '你有一笔付款还在处理中，请先完成它，或等它超时关闭后再试。'],
      ['CONFLICT', '创始会员名额已售完。'],
      ['FORBIDDEN', '账号已停用或正在注销，不能购买。'],
      ['BAD_REQUEST', '这个优惠不适用于所选套餐，请刷新页面后重试。'],
    ]) {
      expect(describeCheckoutError(trpcError(code, message))).toEqual({ message, goldFirstIneligible: false,
        founderSoldOut: message === '创始会员名额已售完。', founderIneligible: false });
    }
  });
  it('marks the Gold first-month refusal so the user can switch to the standard price', () => {
    expect(describeCheckoutError(trpcError('PRECONDITION_FAILED', 'Gold 首月优惠仅限首次购买 Gold 的账号，你的账号不符合条件。')))
      .toEqual({ message: 'Gold 首月优惠仅限首次购买 Gold 的账号，你的账号不符合条件。', goldFirstIneligible: true, founderSoldOut: false,
        founderIneligible: false });
    // A former founder: the founder price is refused, the standard yearly plan is not.
    for (const message of ['你已购买过创始会员，请通过创始会员续费入口操作。', '创始会员续费资格已过期。']) {
      expect(describeCheckoutError(trpcError('PRECONDITION_FAILED', message))).toMatchObject({ message, founderIneligible: true });
    }
  });
  it('gives one generic line for outages, input errors and unknown failures', () => {
    expect(describeCheckoutError(trpcError('SERVICE_UNAVAILABLE', 'whatever')).message).toBe(CHECKOUT_COPY.unavailable);
    expect(describeCheckoutError(trpcError('BAD_REQUEST', '[{"message":"Invalid input"}]')).message).toBe(CHECKOUT_COPY.unavailable);
    expect(describeCheckoutError(trpcError('INTERNAL_SERVER_ERROR', 'boom')).message).toBe(CHECKOUT_COPY.unavailable);
    expect(describeCheckoutError(new Error('Failed to fetch')).message).toBe(CHECKOUT_COPY.unavailable);
    expect(CHECKOUT_COPY.unavailable).toBe('暂时无法创建付款，请稍后查看原订单状态');
  });
  it('turns rate limiting into a friendly wait', () => {
    expect(describeCheckoutError(trpcError('TOO_MANY_REQUESTS', '请求过于频繁，请在 42 秒后重试')).message).toBe('请求过于频繁，请在 42 秒后重试');
    expect(describeCheckoutError(trpcError('TOO_MANY_REQUESTS', 'Too many')).message).toBe(CHECKOUT_COPY.rateLimited);
  });
});

it('counts only real positive founder seats from the server', () => {
  expect(founderSeatsLeft(entry({ founder: { total: 50, available: 13 } }))).toBe(13);
  expect(founderSeatsLeft(entry({ founder: { total: 50, available: 0 } }))).toBe(0);
  expect(founderSeatsLeft(entry({ founder: { total: 50, available: -1 } }))).toBe(0);
  expect(founderSeatsLeft(entry())).toBe(0);
});
