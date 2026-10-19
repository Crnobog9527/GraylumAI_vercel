/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { expect, it } from 'vitest';
import { PAYMENT_NOTICE_TEMPLATES } from './registry';
import { PAYMENT_NOTICE_CRON_KINDS, PAYMENT_NOTICE_KINDS } from './templates';
const endDate = '2027-03-01T04:00:00+00:00';
const params = { endDate, deadline: '2027-03-08T04:00:00+00:00', stage: '-7d', plan: 'gold', amount: '496.00', managed: true };
it.each(PAYMENT_NOTICE_KINDS)('renders stable bilingual plain text and escaped HTML for %s', kind => {
  const template = PAYMENT_NOTICE_TEMPLATES[kind]!;
  const rendered = template.render(params);
  expect(rendered).toEqual(template.render(params));
  expect(rendered.text).toContain('这是关于你的订单的通知');
  expect(rendered.text).toContain('This is a notice about your order.');
  expect(rendered.text).not.toContain('undefined');
  expect(rendered.html).not.toMatch(/<script|<img|<iframe/);
  expect(template.version).toBe('pay-n2-v1');
});
it('keeps the legacy card template renderable while excluding card renewals from cron kinds', () => {
  expect(PAYMENT_NOTICE_CRON_KINDS).not.toContain('card_renewal_upcoming');
  expect(PAYMENT_NOTICE_TEMPLATES.card_renewal_upcoming!.render(params).text)
    .toContain('Your annual subscription is due to renew');
});
it('tells managed card users about tax and cancellation, uses the frozen list price', () => {
  const text = PAYMENT_NOTICE_TEMPLATES.card_renewal_upcoming!.render(params).text;
  expect(text).toContain('USD 496.00 before tax');
  expect(text).toContain('Applicable taxes are added');
  expect(text).toContain('https://app.graylum.com/profile?tab=subscription');
  const domestic = PAYMENT_NOTICE_TEMPLATES.card_renewal_upcoming!.render({ ...params, managed: false }).text;
  expect(domestic).not.toContain('Link');
});
it('founder expiry includes the renewal price and grace deadline; rejects missing facts', () => {
  const text = PAYMENT_NOTICE_TEMPLATES.wallet_founder_expiry!.render(params).text;
  expect(text).toContain('USD 496');
  expect(text).toContain('2027-03-08 04:00:00 UTC');
  expect(text).toContain('https://www.graylum.com/pricing');
  expect(() => PAYMENT_NOTICE_TEMPLATES.wallet_founder_expiry!.render({ ...params, deadline: null })).toThrow();
  expect(() => PAYMENT_NOTICE_TEMPLATES.card_renewal_upcoming!.render({ ...params, amount: null })).toThrow();
});
it('restored Pro and won disputes never promise automatic charging', () => {
  for (const kind of ['restore_pro_expiry', 'dispute_won_resubscribe'] as const) {
    expect(PAYMENT_NOTICE_TEMPLATES[kind]!.render(params).text).toContain('不会自动扣');
  }
});
