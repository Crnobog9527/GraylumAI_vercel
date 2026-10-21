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
    title: 'Privacy Policy',
    description: 'How Graylum AI collects, uses, shares and protects your personal information.',
    path: '/privacy',
  });
}

export default function PrivacyPage() {
  return <LegalDocumentPage name="privacy" />;
}
