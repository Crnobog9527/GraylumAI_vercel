import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: vi.fn(), read: vi.fn(), stripe: vi.fn() }));
vi.mock('react', async importOriginal => ({ ...(await importOriginal<typeof import('react')>()), cache: <T>(fn: T) => fn }));
vi.mock('@repo/api/src/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@repo/api/src/routers/publicOffers', () => ({ publicOffersStripe: mocks.stripe }));
vi.mock('@repo/api/src/services/payments/publicOffers', () => ({ readPublicOffers: mocks.read }));

import { getLandingOffers, LANDING_PROMO_OFFERS_ENV } from './landing-offers';

const db = { from: vi.fn() };

beforeEach(() => {
  mocks.context.mockReset().mockResolvedValue({ hasSupabaseAdminPrivileges: true, supabaseAdmin: db });
  mocks.stripe.mockReset().mockReturnValue({ stripe: true });
  mocks.read.mockReset().mockResolvedValue({ goldFirstMonth: 49, founder: { price: 496, total: 50, available: 50 } });
  vi.stubEnv('SECURITY_E2E_LOCAL_ONLY', '');
});
afterEach(() => vi.unstubAllEnvs());

it.each([undefined, '', 'true', 'ON', ' on'])('shows no promotional offer and reads nothing while the switch is %j', async value => {
  vi.stubEnv(LANDING_PROMO_OFFERS_ENV, value);
  await expect(getLandingOffers()).resolves.toEqual({});
  expect(mocks.read).not.toHaveBeenCalled();
});

it('reads the offers from the server rules once the switch is on', async () => {
  vi.stubEnv(LANDING_PROMO_OFFERS_ENV, 'on');
  await expect(getLandingOffers()).resolves.toEqual({ goldFirstMonth: 49, founder: { price: 496, total: 50, available: 50 } });
  expect(mocks.read).toHaveBeenCalledWith(db, { stripe: true });
});

it('hides the offers when the read fails', async () => {
  vi.stubEnv(LANDING_PROMO_OFFERS_ENV, 'on');
  mocks.read.mockRejectedValue(new Error('down'));
  await expect(getLandingOffers()).resolves.toEqual({});
});
