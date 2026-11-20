/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Page } from '@playwright/test';
import { simulateCheckoutData } from './simulatedCheckoutData';

/** Simulate only checkout display readiness for the isolated purchase-intent test.
 * Actual provider calls and payment mutations are never intercepted or sent by that test. */
export async function simulateCheckoutDisplay(page: Page) {
  if (process.env.RELEASE_PREFLIGHT_ISOLATED !== '1' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.PLAYWRIGHT_BASE_URL ?? '')) {
    throw new Error('checkout display simulation requires the isolated local rehearsal');
  }
  let blockedPaymentWrites = 0;
  await page.route('**/api/trpc/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== process.env.PLAYWRIGHT_BASE_URL) return route.continue();
    let names: string[];
    try { names = decodeURIComponent(url.pathname.split('/api/trpc/')[1] ?? '').split(','); }
    catch { blockedPaymentWrites++; return route.abort('blockedbyclient'); }
    if (request.method() !== 'GET' && names.some(name => name.startsWith('payments.'))) {
      blockedPaymentWrites++;
      return route.abort('blockedbyclient');
    }
    if (request.method() !== 'GET') return route.continue();
    if (!names.some(name => name === 'payments.methodMembership' || name === 'settings.getMembershipPlans')) return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body: unknown = await response.json();
    simulateCheckoutData(names, body);
    await route.fulfill({ response, json: body });
  });
  return () => blockedPaymentWrites;
}
