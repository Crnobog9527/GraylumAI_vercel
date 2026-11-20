/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Change only successful catalog/entry reads; leave all unrelated results and failures intact. */
export function simulateCheckoutData(names: string[], body: unknown) {
  const rows = Array.isArray(body) ? body : [body];
  for (let i = 0; i < names.length; i++) {
    const row = rows[i] as { result?: { data?: unknown } } | undefined;
    if (!row?.result?.data) continue;
    if (names[i] === 'settings.getMembershipPlans' && Array.isArray(row.result.data)) {
      row.result.data = row.result.data.map(plan => plan && typeof plan === 'object' && plan.level === 'gold'
        ? { ...plan, checkoutReady: { monthly: true, yearly: true } } : plan);
    }
    if (names[i] === 'payments.methodMembership' && row.result.data !== null && typeof row.result.data === 'object' && !Array.isArray(row.result.data)
      && 'checkoutReady' in row.result.data && typeof row.result.data.checkoutReady === 'boolean'
      && 'checkoutMethods' in row.result.data && Array.isArray(row.result.data.checkoutMethods)
      && 'memberships' in row.result.data && Array.isArray(row.result.data.memberships)) {
      row.result.data = { ...row.result.data, mode: 'test', purchaseChannel: 'stripe', checkoutReady: true,
        termsVersion: 'isolated-test-terms', checkoutMethods: ['card'],
        routes: { version: 1, card: { enabled: true }, card_cn: { enabled: false },
          wechat_pay: { enabled: false, annualVerified: false }, alipay: { enabled: false, annualVerified: false } } };
    }
  }
  return body;
}
