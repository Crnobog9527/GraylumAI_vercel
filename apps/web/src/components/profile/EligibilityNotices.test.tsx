/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { EligibilityNotices } from './EligibilityNotices';
import { UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE } from './subscriptionPlanButtonState';

it('shows the unpaid-subscription explanation once on the subscription page, where the disabled buttons cannot', () => {
  const html = renderToStaticMarkup(<EligibilityNotices entries={[
    { reasonCode: 'PAYMENT_ATTENTION_REQUIRED', action: 'resolvePaymentIssue' },
    { reasonCode: 'PAYMENT_ATTENTION_REQUIRED', action: 'resolvePaymentIssue' },
  ]} />);
  // Rendered HTML escapes the quotes in the text, so count its opening clause.
  const opening = UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE.slice(0, 14);
  expect(opening).toBe('你还有一个付款没有成功的订阅');
  expect(html.split(opening).length - 1).toBe(1);
  expect(html).not.toContain('已安排到期取消');
});

it('keeps the restore-renewal notice and shows nothing when purchases are allowed', () => {
  expect(renderToStaticMarkup(<EligibilityNotices entries={[{ reasonCode: 'RENEWAL_RESTORE_REQUIRED', action: 'none' }]} />))
    .toContain('已安排到期取消');
  expect(renderToStaticMarkup(<EligibilityNotices entries={[{ reasonCode: 'ALLOWED', action: 'createCheckoutSession' }]} />)).toBe('');
  expect(renderToStaticMarkup(<EligibilityNotices />)).toBe('');
});
