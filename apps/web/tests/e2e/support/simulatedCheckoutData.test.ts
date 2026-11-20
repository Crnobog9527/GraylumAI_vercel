/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { simulateCheckoutData } from './simulatedCheckoutData';

it('simulates only successful checkout display reads in a batch', () => {
  const body = [ { result: { data: [{ level: 'free', checkoutReady: false }, { level: 'gold', checkoutReady: false }] } },
    { error: { code: 'unavailable' } }, { result: { data: { marker: 'unchanged' } } } ];
  simulateCheckoutData(['settings.getMembershipPlans', 'payments.methodMembership', 'user.getProfile'], body);
  expect(body[0].result?.data).toEqual([{ level: 'free', checkoutReady: false },
    { level: 'gold', checkoutReady: { monthly: true, yearly: true } }]);
  expect(body[1]).toEqual({ error: { code: 'unavailable' } });
  expect(body[2]).toEqual({ result: { data: { marker: 'unchanged' } } });
});
it('sets synthetic terms and card display on a successful isolated membership read', () => {
  const body = { result: { data: { memberships: [], checkoutMethods: [], checkoutReady: false } } };
  simulateCheckoutData(['payments.methodMembership'], body);
  expect(body.result.data).toMatchObject({ checkoutReady: true, mode: 'test', termsVersion: 'isolated-test-terms',
    checkoutMethods: ['card'], memberships: [] });
});
it.each([[], {}, { checkoutReady: false, checkoutMethods: [], memberships: 'invalid' }])(
  'does not turn a malformed membership response into a successful display fixture', data => {
    const body = { result: { data } };
    expect(simulateCheckoutData(['payments.methodMembership'], body)).toEqual({ result: { data } });
  },
);
