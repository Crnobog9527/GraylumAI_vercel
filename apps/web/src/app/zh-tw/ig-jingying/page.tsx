/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { ArticlePage } from '@/components/public-site/ArticlePage';
import { getPublicSiteSettings } from '@/lib/public-site';
import { articleMetadata } from '@/lib/seo/article';
import { ZH_TW_IG_JINGYING } from '@/lib/seo/content/zh-tw/ig-jingying';

// Static with hourly refresh (SEO_GEO_SPEC section 9); only the footer e-mail comes from site settings.
export const revalidate = 3600;

export function generateMetadata() {
  return articleMetadata(ZH_TW_IG_JINGYING);
}

export default async function Page() {
  const { supportEmail } = await getPublicSiteSettings();
  return <ArticlePage content={ZH_TW_IG_JINGYING} supportEmail={supportEmail} />;
}
