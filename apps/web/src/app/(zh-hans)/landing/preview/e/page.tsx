/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PreviewE } from '@/components/landing/preview-e/PreviewE';
import { resolveLandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { getPublicSiteSettings } from '@/lib/public-site';
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';
import { NOINDEX_ROBOTS } from '@/lib/seo/metadata';
import { buildAuthHref } from '@/lib/site-config';

// Style sample E (PUBLIC-SITE): same rules as /landing/preview/[variant] — static like the landing page, never
// indexed, not in the sitemap or any navigation, and a 404 wherever the public site is indexable. Its own folder
// so it does not touch the shared sample list; removed once a style is chosen.
export const revalidate = 3600;

export const metadata: Metadata = { title: 'Graylum 风格样稿 E', robots: NOINDEX_ROBOTS };

export default async function LandingPreviewEPage() {
  if (isPublicIndexingEnabled(process.env[SITE_INDEXING_ENV])) notFound();
  const { siteName, membershipPlans, membershipPlansStatus } = await getPublicSiteSettings();
  const data = buildLandingPageData(resolveLandingFlags(), membershipPlansStatus === 'available' ? membershipPlans : []);
  return <PreviewE data={data} siteName={siteName} membershipHref={buildAuthHref('/app/profile?tab=subscription')} />;
}
