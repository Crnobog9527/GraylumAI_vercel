/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { ArticlePage } from '@/components/public-site/ArticlePage';
import { getPublicSiteSettings } from '@/lib/public-site';
import { articleMetadata } from '@/lib/seo/article';
import { compareHans } from '@/lib/seo/content/compare';

// Static with hourly refresh (SEO_GEO_SPEC section 9); Graylum's price in the table comes from the plan catalog.
export const revalidate = 3600;

export function generateMetadata() {
  return articleMetadata(compareHans());
}

export default async function Page() {
  const { supportEmail, membershipPlans, membershipPlansStatus } = await getPublicSiteSettings();
  const plans = membershipPlansStatus === 'available' ? membershipPlans : [];
  return <ArticlePage content={compareHans(plans)} supportEmail={supportEmail} />;
}
