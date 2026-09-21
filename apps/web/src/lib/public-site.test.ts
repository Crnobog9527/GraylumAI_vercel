import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publicSiteMocks = vi.hoisted(() => ({
  createTRPCContext: vi.fn(),
  getSystemSettings: vi.fn(),
  getMembershipPlans: vi.fn(),
  getFeaturedModules: vi.fn(),
}));

vi.mock('@repo/api/src/trpc', () => ({
  createTRPCContext: publicSiteMocks.createTRPCContext,
}));

vi.mock('@repo/api/src/root', () => ({
  appRouter: {
    createCaller: () => ({
      settings: {
        getSystemSettings: publicSiteMocks.getSystemSettings,
        getMembershipPlans: publicSiteMocks.getMembershipPlans,
      },
      modules: {
        getFeaturedModules: publicSiteMocks.getFeaturedModules,
      },
    }),
  },
}));

import { getPublicSiteSettings } from './public-site';

describe('getPublicSiteSettings catalog status', () => {
  const originalSecurityE2ELocalOnly = process.env.SECURITY_E2E_LOCAL_ONLY;

  beforeEach(() => {
    delete process.env.SECURITY_E2E_LOCAL_ONLY;
    publicSiteMocks.createTRPCContext.mockReset().mockResolvedValue({});
    publicSiteMocks.getSystemSettings.mockReset().mockResolvedValue({
      site_name: 'Graylum',
      support_email: 'support@example.com',
    });
    publicSiteMocks.getFeaturedModules.mockReset().mockResolvedValue([]);
    publicSiteMocks.getMembershipPlans.mockReset();
  });

  afterEach(() => {
    if (originalSecurityE2ELocalOnly === undefined) {
      delete process.env.SECURITY_E2E_LOCAL_ONLY;
    } else {
      process.env.SECURITY_E2E_LOCAL_ONLY = originalSecurityE2ELocalOnly;
    }
  });

  it('uses deterministic fallback settings without remote reads in secretless local E2E', async () => {
    process.env.SECURITY_E2E_LOCAL_ONLY = 'true';

    await expect(getPublicSiteSettings()).resolves.toMatchObject({
      membershipPlansStatus: 'unavailable',
      membershipPlans: [],
      featuredModules: [],
    });
    expect(publicSiteMocks.createTRPCContext).not.toHaveBeenCalled();
    expect(publicSiteMocks.getSystemSettings).not.toHaveBeenCalled();
    expect(publicSiteMocks.getMembershipPlans).not.toHaveBeenCalled();
    expect(publicSiteMocks.getFeaturedModules).not.toHaveBeenCalled();
  });

  it('reports available when the catalog succeeds with plans', async () => {
    const plans = [{ id: 'plan-pro', name: 'Pro' }];
    publicSiteMocks.getMembershipPlans.mockResolvedValue(plans);

    await expect(getPublicSiteSettings()).resolves.toMatchObject({
      membershipPlansStatus: 'available',
      membershipPlans: plans,
    });
  });

  it('reports empty only when the catalog succeeds with no active plans', async () => {
    publicSiteMocks.getMembershipPlans.mockResolvedValue([]);

    await expect(getPublicSiteSettings()).resolves.toMatchObject({
      membershipPlansStatus: 'empty',
      membershipPlans: [],
    });
  });

  it('reports unavailable when the membership catalog rejects', async () => {
    publicSiteMocks.getMembershipPlans.mockRejectedValue(new Error('catalog unavailable'));

    await expect(getPublicSiteSettings()).resolves.toMatchObject({
      membershipPlansStatus: 'unavailable',
      membershipPlans: [],
    });
  });

  it('keeps membership availability when featured modules fail', async () => {
    const plans = [{ id: 'plan-pro', name: 'Pro' }];
    publicSiteMocks.getMembershipPlans.mockResolvedValue(plans);
    publicSiteMocks.getFeaturedModules.mockRejectedValue(new Error('modules unavailable'));

    await expect(getPublicSiteSettings()).resolves.toMatchObject({
      membershipPlansStatus: 'available',
      membershipPlans: plans,
      featuredModules: [],
    });
  });

  it('reports the catalog unavailable when bootstrap context or settings fail', async () => {
    publicSiteMocks.createTRPCContext.mockRejectedValue(new Error('context unavailable'));

    await expect(getPublicSiteSettings()).resolves.toMatchObject({
      membershipPlansStatus: 'unavailable',
      membershipPlans: [],
    });
    expect(publicSiteMocks.getMembershipPlans).not.toHaveBeenCalled();
  });
});
