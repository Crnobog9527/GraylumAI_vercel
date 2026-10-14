/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SampleJ } from '@/components/landing/preview-j/SampleJ';
import { monthlyCredits, pickPaywallPlans } from '@/components/paywall/paywallPlans';
import { resolveLandingFlags } from '@/lib/landing/landing-flags';
import { withLocalSamplePricing } from '@/lib/dev/local-sample-pricing';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { getLandingOffers } from '@/lib/landing/landing-offers';
import { getPublicSiteSettings } from '@/lib/public-site';
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';
import { NOINDEX_ROBOTS } from '@/lib/seo/metadata';

// Style sample J (PUBLIC-SITE): same rules as the /landing/preview/[variant] samples of #893. Static like the
// landing page, never indexed, not in the sitemap or any navigation, and gone once the public site is indexable.
export const revalidate = 3600;

export const metadata: Metadata = { title: 'Graylum 风格样稿 J', robots: NOINDEX_ROBOTS };

export default async function LandingPreviewJ() {
  if (isPublicIndexingEnabled(process.env[SITE_INDEXING_ENV])) notFound();
  const [{ siteName, membershipPlans, membershipPlansStatus }, offers] = await Promise.all([getPublicSiteSettings(), getLandingOffers()]);
  // Plan prices, the Gold first month and the founder seats come from the server, as on /landing (#987). Only a local
  // development server without that data falls back to fixed sample prices, marked as such on the cards.
  const priced = withLocalSamplePricing(process.env, membershipPlansStatus === 'available' ? membershipPlans : [], offers);
  const flags = resolveLandingFlags();
  const flagsUsed = priced.sample ? { ...flags, founder: true } : flags;
  const data = buildLandingPageData(flagsUsed, priced.plans, priced.offers);
  // Monthly credits per plan for the cards, from the same catalog; the founder seat total for v25's seat bar.
  const credits = Object.fromEntries(pickPaywallPlans(priced.plans)
    .filter(plan => plan.level === 'pro' || plan.level === 'gold')
    .map(plan => [plan.level, monthlyCredits(plan)]));
  // The sample reports are not generated yet: their placeholder shows only in a local development preview, or once the
  // landing flag is turned on (off on staging and production by default).
  const showSamples = flags.sampleReports || process.env.NODE_ENV === 'development';
  const extras = {
    founderTotal: priced.offers.founder?.total ?? null, founderPrice: priced.offers.founder?.price ?? null, credits, flags: flagsUsed, showSamples,
  };
  return <SampleJ data={data} siteName={siteName} extras={extras} samplePricing={priced.sample} />;
}
