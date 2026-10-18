/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { notFound } from 'next/navigation';
import { withLocalSamplePricing } from '@/lib/dev/local-sample-pricing';
import { resolveLandingFlags } from '@/lib/landing/landing-flags';
import { getLandingOffers } from '@/lib/landing/landing-offers';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { getPublicSiteSettings } from '@/lib/public-site';
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';

/**
 * The data of a sample S page, read the way sample L's page reads it (same flags, same founder rule). Like every
 * /landing/preview sample: never indexed, and gone once the public site is indexable.
 */
export async function loadSampleS() {
  if (isPublicIndexingEnabled(process.env[SITE_INDEXING_ENV])) notFound();
  const [{ siteName, membershipPlans, membershipPlansStatus }, offers] = await Promise.all([getPublicSiteSettings(), getLandingOffers()]);
  const priced = withLocalSamplePricing(process.env, membershipPlansStatus === 'available' ? membershipPlans : [], offers);
  const flags = { ...resolveLandingFlags(), founder: false };
  return { siteName, flags, data: buildLandingPageData(flags, priced.plans, priced.offers) };
}
