/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useParams } from 'next/navigation';
import { ReviewPage } from '@/components/fusion-review/ReviewPage';

/** One jury review of a positioning analysis (FUSION-REVIEW PR-5): its own address, so a refresh or a link comes back. */
export default function PositioningReviewPage() {
  const params = useParams<{ draftId: string; reviewId: string }>();
  return <ReviewPage key={params?.reviewId} draftId={params?.draftId ?? ''} reviewId={params?.reviewId ?? ''} />;
}
