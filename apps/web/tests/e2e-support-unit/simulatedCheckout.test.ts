/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import type { Page, Route } from '@playwright/test';
import { simulateCheckoutDisplay } from '../e2e/support/simulatedCheckout';

afterEach(() => vi.unstubAllEnvs());
it.each(['payments.methodCheckout', 'payments%2EmethodCheckout', 'user.getProfile%2Cpayments.methodCheckout', '%ZZ'])(
  'blocks and counts a payment mutation or malformed path without sending it: %s', async path => {
  vi.stubEnv('RELEASE_PREFLIGHT_ISOLATED', '1');
  vi.stubEnv('PLAYWRIGHT_BASE_URL', 'http://127.0.0.1:1234');
  let handler: (route: Route) => Promise<unknown> = async () => {};
  const page = { route: async (_pattern: string, fn: typeof handler) => { handler = fn; } } as unknown as Page;
  const count = await simulateCheckoutDisplay(page);
  const abort = vi.fn(), proceed = vi.fn();
  await handler({ request: () => ({ url: () => `http://127.0.0.1:1234/api/trpc/${path}`,
    method: () => 'POST' }), abort, continue: proceed } as unknown as Route);
  expect(abort).toHaveBeenCalledWith('blockedbyclient');
  expect(proceed).not.toHaveBeenCalled();
  expect(count()).toBe(1);
});
it('refuses to install against a remote target', async () => {
  vi.stubEnv('RELEASE_PREFLIGHT_ISOLATED', '1');
  vi.stubEnv('PLAYWRIGHT_BASE_URL', 'https://example.invalid');
  await expect(simulateCheckoutDisplay({} as Page)).rejects.toThrow('isolated local rehearsal');
});
