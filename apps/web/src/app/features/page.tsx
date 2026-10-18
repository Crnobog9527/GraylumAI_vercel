/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { ArticlePage } from '@/components/public-site/ArticlePage';
import { getPublicSiteSettings } from '@/lib/public-site';
import { articleMetadata } from '@/lib/seo/article';
import { withPricing } from '@/lib/seo/content/feature-pricing';
import { FEATURES_HUB } from '@/lib/seo/content/features';

// Static with hourly refresh (SEO_GEO_SPEC section 9); only the footer e-mail comes from site settings.
export const revalidate = 3600;

export function generateMetadata() {
  return articleMetadata(FEATURES_HUB);
}

export default async function Page() {
  const { supportEmail, membershipPlans, membershipPlansStatus } = await getPublicSiteSettings();
  const plans = membershipPlansStatus === 'available' ? membershipPlans : [];
  return <ArticlePage content={withPricing(FEATURES_HUB, 'hub', plans)} supportEmail={supportEmail} />;
}
