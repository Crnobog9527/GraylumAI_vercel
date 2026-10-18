/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleM } from '@/components/landing/preview-m/SampleM';
import { resolveLandingFlags } from '@/lib/landing/landing-flags';
import { withLocalSamplePricing } from '@/lib/dev/local-sample-pricing';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { getLandingOffers } from '@/lib/landing/landing-offers';
import { getPublicSiteSettings } from '@/lib/public-site';
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';
import { NOINDEX_ROBOTS } from '@/lib/seo/metadata';
import { buildAuthHref } from '@/lib/site-config';

// Style sample M (PUBLIC-SITE): direction H, product-led, on sample L's content (Owner 2026-10-17). Same rules as
// the /landing/preview/[variant] samples of #893: static like the landing page, never indexed, not in the sitemap or any
// navigation, and gone once the public site is indexable.
export const revalidate = 3600;

export const metadata: Metadata = { title: 'Graylum 风格样稿 M', robots: NOINDEX_ROBOTS };

export default async function LandingPreviewM() {
  if (isPublicIndexingEnabled(process.env[SITE_INDEXING_ENV])) notFound();
  const [{ siteName, membershipPlans, membershipPlansStatus }, offers] = await Promise.all([getPublicSiteSettings(), getLandingOffers()]);
  // The Pro price ("$29/月起") comes from the server catalog, as on /landing (#987). Only a local development server
  // without that data falls back to the paywall's final prices (not marked on the page: Owner 2026-10-15).
  const priced = withLocalSamplePricing(process.env, membershipPlansStatus === 'available' ? membershipPlans : [], offers);
  const flags = resolveLandingFlags();
  // Owner 2026-10-15: the founder offer is off the home page, so its FAQ entries go with it.
  const flagsUsed = { ...flags, founder: false };
  const data = buildLandingPageData(flagsUsed, priced.plans, priced.offers);
  // The sample reports are not generated yet: their placeholder shows only in a local development preview, or once the
  // landing flag is turned on (off on staging and production by default).
  const extras = { flags: flagsUsed, showSamples: flags.sampleReports || process.env.NODE_ENV === 'development' };
  return <SampleM data={data} siteName={siteName} extras={extras} membershipHref={buildAuthHref('/profile?tab=subscription')} />;
}
