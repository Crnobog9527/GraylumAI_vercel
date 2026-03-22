/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { Metadata } from 'next';
import { unstable_noStore as noStore } from 'next/cache';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext } from '@repo/api/src/trpc';
import { resolveSiteName, resolveSupportEmail } from '@/lib/site-config';

function parseBooleanSetting(value: unknown, fallback: boolean) {
  if (value === true || value === 'true') {
    return true;
  }

  if (value === false || value === 'false') {
    return false;
  }

  return fallback;
}

export async function getPublicSiteSettings() {
  noStore();

  try {
    const ctx = await createTRPCContext({ headers: new Headers() });
    const caller = appRouter.createCaller(ctx);
    const [settings, membershipPlans, featuredModules] = await Promise.all([
      caller.settings.getSystemSettings(),
      caller.settings.getMembershipPlans(),
      caller.modules.getFeaturedModules({ limit: 4 }),
    ]);

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
      featuredModules,
    };
  } catch {
    return {
      siteName: resolveSiteName(),
      supportEmail: resolveSupportEmail(),
      showOnboarding: true,
      showFeaturedModules: true,
      membershipPlans: [],
      featuredModules: [],
    };
  }
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
