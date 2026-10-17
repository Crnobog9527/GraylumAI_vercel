/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { notFound } from 'next/navigation';
import { FeatureDemo } from '@/components/public-site/features/FeatureDemo';
import { ArticlePage } from '@/components/public-site/ArticlePage';
import { getPublicSiteSettings } from '@/lib/public-site';
import { articleMetadata } from '@/lib/seo/article';
import { withPricing } from '@/lib/seo/content/feature-pricing';
import { FEATURES, findFeature, TEXT_ONLY_FEATURES } from '@/lib/seo/content/features';

// Static with hourly refresh (SEO_GEO_SPEC section 9). Only the pages in FEATURES exist; any other address is a real 404.
export const revalidate = 3600;
export const dynamicParams = false;

export function generateStaticParams() {
  return FEATURES.map(entry => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const entry = findFeature((await params).slug);
  return entry ? articleMetadata(entry.content) : {};
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const entry = findFeature((await params).slug);
  if (!entry) notFound();
  const { supportEmail, membershipPlans, membershipPlansStatus } = await getPublicSiteSettings();
  const plans = membershipPlansStatus === 'available' ? membershipPlans : [];
  const demo = TEXT_ONLY_FEATURES.includes(entry.slug) ? undefined : <FeatureDemo slug={entry.slug} />;
  return <ArticlePage content={withPricing(entry.content, entry.slug, plans)} supportEmail={supportEmail} demo={demo} />;
}
