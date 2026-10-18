/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Metadata } from 'next';
import { loadSampleS } from '@/components/landing/preview-s/load-s';
import { SampleS } from '@/components/landing/preview-s/SampleS';
import { NOINDEX_ROBOTS } from '@/lib/seo/metadata';

// Art direction sample S3 (PUBLIC-SITE, Owner 2026-10-18): 创作者的剪贴本. Sample L's first screen, step one with the
// jury, and footer in a new backdrop; local preview only, never indexed.
export const revalidate = 3600;

export const metadata: Metadata = { title: 'Graylum 艺术方向小样 S3', robots: NOINDEX_ROBOTS };

export default async function LandingPreviewS3() {
  const { siteName, flags, data } = await loadSampleS();
  return <SampleS variant="s3" siteName={siteName} flags={flags} heroNote={data.heroNote} />;
}
