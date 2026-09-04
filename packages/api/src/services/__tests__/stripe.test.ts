import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const stripeState = vi.hoisted(() => ({
  retrieve: vi.fn(),
  create: vi.fn(),
}));

vi.mock('stripe', async () => {
  class StripeInvalidRequestError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  }

  class StripeMock {
    static errors = { StripeInvalidRequestError };
    customers = {
      retrieve: stripeState.retrieve,
      create: stripeState.create,
    };
    constructor() {}
  }

  return {
    default: StripeMock,
  };
});

describe('stripe service helpers', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    stripeState.retrieve.mockReset();
    stripeState.create.mockReset();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('reports checkout as configured only when all required Stripe env vars are present', async () => {
    const {
      getStripeCheckoutConfigurationIssues,
      isStripeCheckoutConfigured,
    } = await import('../stripe');

    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890';
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_1234567890';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_1234567890';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

    expect(isStripeCheckoutConfigured()).toBe(true);
    expect(getStripeCheckoutConfigurationIssues()).toEqual([]);

    delete process.env.STRIPE_WEBHOOK_SECRET;

    expect(isStripeCheckoutConfigured()).toBe(false);
    expect(getStripeCheckoutConfigurationIssues()).toEqual(['STRIPE_WEBHOOK_SECRET']);
  });

  it('normalizes NEXT_PUBLIC_APP_URL when building checkout return URLs', async () => {
    const { getStripeAppUrl } = await import('../stripe');

    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/';

    expect(getStripeAppUrl()).toBe('https://app.example.com');
  });

  it('prefers the current request origin when building checkout return URLs', async () => {
    const { getStripeAppUrl } = await import('../stripe');

    process.env.NEXT_PUBLIC_APP_URL = 'https://www.graylum.com';

    expect(
      getStripeAppUrl(
        new Headers({
          origin: 'http://127.0.0.1:3001',
        }),
      ),
    ).toBe('http://127.0.0.1:3001');
  });

  it('ignores untrusted header origins and falls back to NEXT_PUBLIC_APP_URL', async () => {
    const { getStripeAppUrl } = await import('../stripe');

    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

    expect(
      getStripeAppUrl(
        new Headers({
          origin: 'https://evil.example.com',
        }),
      ),
    ).toBe('https://app.example.com');
  });

  it('throws when checkout return URL is requested without NEXT_PUBLIC_APP_URL', async () => {
    const { getStripeAppUrl } = await import('../stripe');

    delete process.env.NEXT_PUBLIC_APP_URL;

    expect(() => getStripeAppUrl()).toThrow('NEXT_PUBLIC_APP_URL is not configured');
  });

  it('throws before Stripe receives a malformed checkout return URL', async () => {
    const { getStripeAppUrl } = await import('../stripe');

    process.env.NEXT_PUBLIC_APP_URL = 'NEXT_PUBLIC_APP_URL=https://app.example.com';

    expect(() => getStripeAppUrl()).toThrow('NEXT_PUBLIC_APP_URL is not a valid absolute URL');
  });

  it('throws a single actionable error when Stripe checkout is partially configured', async () => {
    const { assertStripeCheckoutConfigured } = await import('../stripe');

    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890';
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

    expect(() => assertStripeCheckoutConfigured()).toThrow(
      'Stripe checkout is not fully configured: missing NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET',
    );
  });

  it('normalizes membership package discounts and calculates discounted cents', async () => {
    const { calculateDiscountedAmountCents } = await import('../stripe');

    expect(
      calculateDiscountedAmountCents({
        amountCents: 2500,
        packageDiscount: 95,
      }),
    ).toEqual({
      baseAmountCents: 2500,
      normalizedDiscount: 95,
      discountedAmountCents: 2375,
    });

    expect(
      calculateDiscountedAmountCents({
        amountCents: 2500,
        packageDiscount: null,
      }),
    ).toEqual({
      baseAmountCents: 2500,
      normalizedDiscount: 100,
      discountedAmountCents: 2500,
    });

    expect(
      calculateDiscountedAmountCents({
        amountCents: 2500,
        packageDiscount: 120,
      }),
    ).toEqual({
      baseAmountCents: 2500,
      normalizedDiscount: 100,
      discountedAmountCents: 2500,
    });
  });

  it('reuses an existing Stripe customer when it is valid in the active mode', async () => {
    const { getOrCreateStripeCustomerId } = await import('../stripe');

    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890';

    stripeState.retrieve.mockResolvedValue({
      id: 'cus_test_existing',
      deleted: false,
    });

    const supabase = {
      from(table: string) {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          not() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data:
                table === 'user_subscriptions'
                  ? { stripe_customer_id: 'cus_test_existing' }
                  : null,
            });
          },
        };
      },
    };

    const customerId = await getOrCreateStripeCustomerId({
      supabase,
      userId: 'user-1',
      email: 'user@example.com',
      nickname: 'User',
    });

    expect(customerId).toBe('cus_test_existing');
    expect(stripeState.retrieve).toHaveBeenCalledWith('cus_test_existing');
    expect(stripeState.create).not.toHaveBeenCalled();
  });

  it('recreates the Stripe customer when the stored customer only exists in another mode', async () => {
    const { getOrCreateStripeCustomerId } = await import('../stripe');

    process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890';

    stripeState.retrieve.mockRejectedValue(
      new (await import('stripe')).default.errors.StripeInvalidRequestError(
        'No such customer',
        'resource_missing',
      ),
    );
    stripeState.create.mockResolvedValue({
      id: 'cus_test_new',
    });

    const supabase = {
      from(table: string) {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          not() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({
              data:
                table === 'user_subscriptions'
                  ? { stripe_customer_id: 'cus_live_existing' }
                  : null,
            });
          },
        };
      },
    };

    const customerId = await getOrCreateStripeCustomerId({
      supabase,
      userId: 'user-1',
      email: 'user@example.com',
      nickname: 'User',
    });

    expect(customerId).toBe('cus_test_new');
    expect(stripeState.retrieve).toHaveBeenCalledWith('cus_live_existing');
    expect(stripeState.create).toHaveBeenCalledWith({
      email: 'user@example.com',
      name: 'User',
      metadata: {
        userId: 'user-1',
      },
    });
  });
});

const limitState = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../redisRateLimiter', () => ({ checkRateLimit: limitState.check }));

describe('PAY-1 payment boundaries', () => {
  beforeEach(() => {
    process.env.VERCEL = '1';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    limitState.check.mockReset().mockResolvedValue({ success: true, limit: 5, remaining: 4 });
  });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  it('uses separate user and trusted IP keys, ignoring spoofed forwarding headers', async () => {
    const { assertCheckoutRateLimit } = await import('../stripe');
    const headers = new Headers({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' });
    await assertCheckoutRateLimit('user-a', headers);
    await assertCheckoutRateLimit('user-b', headers);
    expect(limitState.check.mock.calls).toEqual([
      ['checkout:user:user-a', 'auth'], ['checkout:ip:203.0.113.7', 'anonymous'],
      ['checkout:user:user-b', 'auth'], ['checkout:ip:203.0.113.7', 'anonymous'],
    ]);
  });
  it.each([0, 1])('rejects when dimension %s is over limit', async (dimension) => {
    const { assertCheckoutRateLimit } = await import('../stripe');
    if (dimension) limitState.check.mockResolvedValueOnce({ success: true, limit: 5 });
    limitState.check.mockResolvedValueOnce({ success: false, limit: 5, reason: 'rate_limited' });
    await expect(assertCheckoutRateLimit('user-a', new Headers({ 'x-vercel-forwarded-for': '203.0.113.7' })))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
  it.each([{ success: true, limit: 0 }, { success: false, limit: 0, reason: 'unavailable' }])('fails closed on backend fallback %j', async (result) => {
    const { assertCheckoutRateLimit } = await import('../stripe');
    limitState.check.mockResolvedValueOnce(result);
    await expect(assertCheckoutRateLimit('user-a', new Headers({ 'x-vercel-forwarded-for': '203.0.113.7' })))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it.each(['', 'unknown', '1.2.3.4, 5.6.7.8', 'fake-ip'])('rejects missing or malformed trusted IP %s without a shared unknown bucket', async (ip) => {
    const { assertCheckoutRateLimit } = await import('../stripe');
    await expect(assertCheckoutRateLimit('user-a', new Headers({ 'x-vercel-forwarded-for': ip, 'x-forwarded-for': '1.2.3.4' })))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(limitState.check).not.toHaveBeenCalled();
  });
  it('canonicalizes equivalent IPv6 spellings', async () => {
    const { assertCheckoutRateLimit } = await import('../stripe');
    for (const ip of ['2001:db8::1', '2001:0db8:0:0:0:0:0:1']) {
      await assertCheckoutRateLimit('user-a', new Headers({ 'x-vercel-forwarded-for': ip }));
    }
    expect(limitState.check.mock.calls[1]).toEqual(limitState.check.mock.calls[3]);
  });
  it('allows only the exact server-configured Profile return URL', async () => {
    const { getStripePortalReturnUrl } = await import('../stripe');
    expect(getStripePortalReturnUrl()).toBe('https://app.example.com/profile?tab=subscription');
    expect(getStripePortalReturnUrl('https://app.example.com/profile?tab=subscription')).toBe('https://app.example.com/profile?tab=subscription');
  });
  it.each([
    'https://evil.example/profile?tab=subscription', '//evil.example',
    'javascript:alert(1)', 'https://app.example.com.evil.example/profile?tab=subscription',
    'https://app.example.com@evil.example/profile?tab=subscription',
    'https://app.example.com/profile?tab=subscription&next=https://evil.example',
    'https://app.example.com/profile?tab=subscription#evil',
    'http://app.example.com/profile?tab=subscription', '/profile?tab=subscription',
    'https://app.example.com:444/profile?tab=subscription',
  ])('rejects Portal return URL abuse %s', async (url) => {
    const { getStripePortalReturnUrl } = await import('../stripe');
    expect(() => getStripePortalReturnUrl(url)).toThrow('无效的返回地址');
  });
});
