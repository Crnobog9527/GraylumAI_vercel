/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PreviewPage } from '@/components/landing/preview/PreviewPage';
import { findPreviewVariant, PREVIEW_VARIANTS } from '@/components/landing/preview/variants';
import { resolveLandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { getPublicSiteSettings } from '@/lib/public-site';
import { NOINDEX_ROBOTS } from '@/lib/seo/metadata';
import { buildAuthHref } from '@/lib/site-config';

// Style samples for the Owner (PUBLIC-SITE style unification): static like the landing page, never indexed,
// not in the sitemap or any navigation. Removed once a style is chosen.
export const revalidate = 3600;
export const dynamicParams = false;

export function generateStaticParams() {
  return PREVIEW_VARIANTS.map(variant => ({ variant: variant.id }));
}

export const metadata: Metadata = { title: 'Graylum 风格样稿', robots: NOINDEX_ROBOTS };

export default async function LandingPreviewPage({ params }: { params: Promise<{ variant: string }> }) {
  const variant = findPreviewVariant((await params).variant);
  // Samples exist only on staging and previews; production never serves them.
  if (!variant || process.env.VERCEL_ENV === 'production') notFound();
  const { siteName, membershipPlans, membershipPlansStatus } = await getPublicSiteSettings();
  const data = buildLandingPageData(resolveLandingFlags(), membershipPlansStatus === 'available' ? membershipPlans : []);
  return <PreviewPage variant={variant.id} data={data} siteName={siteName} membershipHref={buildAuthHref('/profile?tab=subscription')} />;
}
