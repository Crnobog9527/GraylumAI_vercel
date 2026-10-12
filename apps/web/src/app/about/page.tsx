/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { ArticlePage } from '@/components/public-site/ArticlePage';
import { getPublicSiteSettings } from '@/lib/public-site';
import { articleMetadata } from '@/lib/seo/article';
import { ABOUT_ZH_HANS } from '@/lib/seo/content/about';

// Static with hourly refresh (SEO_GEO_SPEC section 9); only the footer e-mail comes from site settings.
export const revalidate = 3600;

export function generateMetadata() {
  return articleMetadata(ABOUT_ZH_HANS);
}

export default async function Page() {
  const { supportEmail } = await getPublicSiteSettings();
  return <ArticlePage content={ABOUT_ZH_HANS} supportEmail={supportEmail} />;
}
