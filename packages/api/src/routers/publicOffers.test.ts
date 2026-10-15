/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  limit: vi.fn(), read: vi.fn(), configured: vi.fn(), client: vi.fn(),
}));
vi.mock('../services/redisRateLimiter', () => ({ checkRateLimitOrThrow: mocks.limit }));
vi.mock('../services/payments/publicOffers', () => ({ readPublicOffers: mocks.read }));
vi.mock('../services/stripe', () => ({ isStripeCheckoutConfigured: mocks.configured, getStripeClient: mocks.client }));

import { router } from '../trpc';
import { getPublicOffers } from './publicOffers';
import { RateLimitError } from '../lib/rateLimitError';

const app = router({ getPublicOffers });
const offers = { goldFirstMonth: 49, founder: { price: 496, total: 50, available: 50 } };
const caller = (ctx: Record<string, unknown>) => app.createCaller(ctx as never);

beforeEach(() => {
  mocks.limit.mockReset().mockResolvedValue({ success: true });
  mocks.read.mockReset().mockResolvedValue(offers);
  mocks.configured.mockReset().mockReturnValue(true);
  mocks.client.mockReset().mockReturnValue({ stripe: true });
});

it('needs no sign-in, is rate limited per client address, and returns only the public offer numbers', async () => {
  const db = { from: vi.fn() };
  const result = await caller({ headers: new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }), user: null,
    hasSupabaseAdminPrivileges: true, supabaseAdmin: db }).getPublicOffers();
  expect(result).toEqual(offers);
  expect(mocks.limit).toHaveBeenCalledExactlyOnceWith('public-offers:203.0.113.7', 'anonymous');
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith(db, { stripe: true });
});

it('refuses when the limit is reached or the limiter is unavailable, before any read', async () => {
  mocks.limit.mockRejectedValue(new RateLimitError('rate_limited', 30));
  await expect(caller({ headers: new Headers(), user: null, hasSupabaseAdminPrivileges: true, supabaseAdmin: {} })
    .getPublicOffers()).rejects.toBeTruthy();
  expect(mocks.read).not.toHaveBeenCalled();
});

it('hides the founder offer when Stripe checkout or the service database is not available', async () => {
  mocks.configured.mockReturnValue(false);
  await caller({ headers: new Headers(), user: null, hasSupabaseAdminPrivileges: true, supabaseAdmin: {} }).getPublicOffers();
  expect(mocks.read).toHaveBeenLastCalledWith({}, null);
  await caller({ headers: new Headers(), user: null, hasSupabaseAdminPrivileges: false, supabaseAdmin: null }).getPublicOffers();
  expect(mocks.read).toHaveBeenLastCalledWith(null, null);
});
