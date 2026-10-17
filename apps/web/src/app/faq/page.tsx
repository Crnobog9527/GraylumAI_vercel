/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { FaqPage } from '@/components/public-site/FaqPage';
import { getPublicSiteSettings } from '@/lib/public-site';
import { FAQ_PAGE } from '@/lib/seo/content/faq';
import { buildPageMetadata } from '@/lib/seo/metadata';

// Static with hourly refresh (SEO_GEO_SPEC section 9); only the footer e-mail comes from site settings.
export const revalidate = 3600;

export function generateMetadata() {
  return buildPageMetadata({ title: FAQ_PAGE.metaTitle, description: FAQ_PAGE.metaDescription, path: FAQ_PAGE.path });
}

export default async function Page() {
  const { supportEmail } = await getPublicSiteSettings();
  return <FaqPage supportEmail={supportEmail} />;
}
