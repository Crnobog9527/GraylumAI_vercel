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
    title: 'Cookie Policy',
    description: 'How Graylum AI uses cookies and similar technologies, and how you can control them.',
    path: '/cookies',
  });
}

export default function CookiesPage() {
  return <LegalDocumentPage name="cookies" />;
}
