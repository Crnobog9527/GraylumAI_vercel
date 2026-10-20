/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { RefundPage } from '@/components/public-site/RefundPage';
import { getPublicSiteSettings } from '@/lib/public-site';
import { REFUND_PAGE } from '@/lib/seo/content/refund';
import { buildPageMetadata } from '@/lib/seo/metadata';

// Static with hourly refresh (SEO_GEO_SPEC section 9); only the footer e-mail comes from site settings.
export const revalidate = 3600;

export function generateMetadata() {
  return buildPageMetadata({ title: REFUND_PAGE.metaTitle, description: REFUND_PAGE.metaDescription, path: REFUND_PAGE.path });
}

export default async function Page() {
  const { supportEmail } = await getPublicSiteSettings();
  return <RefundPage supportEmail={supportEmail} />;
}
