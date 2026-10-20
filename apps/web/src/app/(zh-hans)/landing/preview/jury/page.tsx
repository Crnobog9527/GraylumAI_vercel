/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JuryPreview } from '@/components/landing/preview-jury/JuryPreview';
import { isPublicIndexingEnabled, SITE_INDEXING_ENV } from '@/lib/robots-policy';
import { NOINDEX_ROBOTS } from '@/lib/seo/metadata';

// FUSION-REVIEW animation prototype: same rules as the /landing/preview samples. Mock data only, never indexed,
// not in the sitemap or any navigation, and gone once the public site is indexable.
export const revalidate = 3600;

export const metadata: Metadata = { title: 'Graylum 评审团动画原型', robots: NOINDEX_ROBOTS };

export default function LandingPreviewJury() {
  if (isPublicIndexingEnabled(process.env[SITE_INDEXING_ENV])) notFound();
  return <JuryPreview />;
}
