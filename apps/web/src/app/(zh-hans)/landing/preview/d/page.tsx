/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleD } from '@/components/landing/preview-d/SampleD';
import { resolveLandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { getPublicSiteSettings } from '@/lib/public-site';
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';
import { NOINDEX_ROBOTS } from '@/lib/seo/metadata';
import { buildAuthHref } from '@/lib/site-config';

// Style sample D (Impeccable, after ploy.ai's visual language) for the Owner. Same rules as samples a–c:
// static, never indexed, not in the sitemap or any navigation, gone once the public site is indexable.
export const revalidate = 3600;

export const metadata: Metadata = { title: 'Graylum 风格样稿 D', robots: NOINDEX_ROBOTS };

export default async function LandingPreviewD() {
  if (isPublicIndexingEnabled(process.env[SITE_INDEXING_ENV])) notFound();
  const { siteName, membershipPlans, membershipPlansStatus } = await getPublicSiteSettings();
  const data = buildLandingPageData(resolveLandingFlags(), membershipPlansStatus === 'available' ? membershipPlans : []);
  return <SampleD data={data} siteName={siteName} membershipHref={buildAuthHref('/app/profile?tab=subscription')} />;
}
