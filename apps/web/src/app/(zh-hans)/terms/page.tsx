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
    title: 'Terms of Service',
    description: 'The terms that apply when you use Graylum AI, including accounts, payments, subscriptions, AI outputs and refunds.',
    path: '/terms',
  });
}

export default function TermsPage() {
  return <LegalDocumentPage name="terms" />;
}
