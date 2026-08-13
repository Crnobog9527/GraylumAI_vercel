/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { Metadata } from 'next';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext } from '@repo/api/src/trpc';
import { resolveSiteName, resolveSupportEmail } from '@/lib/site-config';

export type PublicSiteSettings = {
  siteName: string;
  supportEmail: string;
  showOnboarding: boolean;
  showFeaturedModules: boolean;
  membershipPlans: any[];
  membershipPlansStatus: PublicCatalogStatus;
  featuredModules: any[];
};

export type PublicCatalogStatus = 'available' | 'empty' | 'unavailable';

function resolveCatalogStatus(result: PromiseSettledResult<unknown[]>): PublicCatalogStatus {
  if (result.status === 'rejected') {
    return 'unavailable';
  }

  return result.value.length > 0 ? 'available' : 'empty';
}

function parseBooleanSetting(value: unknown, fallback: boolean) {
  if (value === true || value === 'true') {
    return true;
  }

  if (value === false || value === 'false') {
    return false;
  }

  return fallback;
}

async function loadPublicSiteSettingsUncached(): Promise<PublicSiteSettings> {
  try {
    const ctx = await createTRPCContext({ headers: new Headers() });
    const caller = appRouter.createCaller(ctx);
    const settings = await caller.settings.getSystemSettings();
    const [membershipPlansResult, featuredModulesResult] = await Promise.allSettled([
      caller.settings.getMembershipPlans(),
      caller.modules.getFeaturedModules({ limit: 4 }),
    ]);

    const membershipPlans =
      membershipPlansResult.status === 'fulfilled' ? membershipPlansResult.value : [];
    const featuredModules =
      featuredModulesResult.status === 'fulfilled' ? featuredModulesResult.value : [];

    return {
      siteName:
        typeof settings.site_name === 'string' && settings.site_name.trim()
          ? settings.site_name.trim()
          : resolveSiteName(),
      supportEmail:
        typeof settings.support_email === 'string' && settings.support_email.trim()
          ? settings.support_email.trim()
          : resolveSupportEmail(),
      showOnboarding: parseBooleanSetting(settings.home_show_onboarding, true),
      showFeaturedModules: parseBooleanSetting(settings.home_show_featured_modules, true),
      membershipPlans,
      membershipPlansStatus: resolveCatalogStatus(membershipPlansResult),
      featuredModules,
    };
  } catch {
    return {
      siteName: resolveSiteName(),
      supportEmail: resolveSupportEmail(),
      showOnboarding: true,
      showFeaturedModules: true,
      membershipPlans: [],
      membershipPlansStatus: 'unavailable',
      featuredModules: [],
    };
  }
}

export async function getPublicSiteSettings(): Promise<PublicSiteSettings> {
  return loadPublicSiteSettingsUncached();
}

export async function buildPublicPageMetadata(
  title: string,
  description: string,
  keywords: string[] = ['AI', '社交媒体', '增长', '内容策略']
): Promise<Metadata> {
  const { siteName } = await getPublicSiteSettings();
  const fullTitle = `${title} | ${siteName}`;

  return {
    title: fullTitle,
    description,
    keywords,
    openGraph: {
      title: fullTitle,
      description,
      type: 'website',
      locale: 'zh_CN',
    },
  };
}
