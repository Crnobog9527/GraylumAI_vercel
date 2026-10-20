/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { LegalDocumentPage } from '@/components/public-site/LegalDocumentPage';
import { buildPageMetadata } from '@/lib/seo/metadata';

// Fully static: the document is a file in this repository (apps/web/content/legal), read at build time.
export const dynamic = 'force-static';

export function generateMetadata() {
  return buildPageMetadata({
    title: 'Refund Policy',
    description: 'When you can request a refund from Graylum AI, how to request it, and what is not refundable.',
    path: '/refund-policy',
  });
}

export default function RefundPolicyPage() {
  return <LegalDocumentPage name="refund-policy" />;
}
