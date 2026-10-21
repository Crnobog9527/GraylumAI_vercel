/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleG } from '@/components/landing/preview-g/SampleG';
import { resolveLandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { getPublicSiteSettings } from '@/lib/public-site';
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';
import { NOINDEX_ROBOTS } from '@/lib/seo/metadata';
import { buildAuthHref } from '@/lib/site-config';

// Style sample G (PUBLIC-SITE): same rules as the /landing/preview/[variant] samples of #893. Static like the
// landing page, never indexed, not in the sitemap or any navigation, and gone once the public site is indexable.
export const revalidate = 3600;

export const metadata: Metadata = { title: 'Graylum 风格样稿 G', robots: NOINDEX_ROBOTS };

export default async function LandingPreviewG() {
  if (isPublicIndexingEnabled(process.env[SITE_INDEXING_ENV])) notFound();
  const { siteName, membershipPlans, membershipPlansStatus } = await getPublicSiteSettings();
  const data = buildLandingPageData(resolveLandingFlags(), membershipPlansStatus === 'available' ? membershipPlans : []);
  return <SampleG data={data} siteName={siteName} membershipHref={buildAuthHref('/app/profile?tab=subscription')} />;
}
