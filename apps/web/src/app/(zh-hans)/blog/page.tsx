/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { BlogIndexPage } from '@/components/public-site/BlogIndexPage';
import { getPublicSiteSettings } from '@/lib/public-site';
import { BLOG_INDEX } from '@/lib/seo/content/blog';
import { buildPageMetadata } from '@/lib/seo/metadata';

// Static with hourly refresh (SEO_GEO_SPEC section 9); only the footer e-mail comes from site settings.
export const revalidate = 3600;

export function generateMetadata() {
  return buildPageMetadata({ title: BLOG_INDEX.metaTitle, description: BLOG_INDEX.metaDescription, path: BLOG_INDEX.path });
}

export default async function Page() {
  const { supportEmail } = await getPublicSiteSettings();
  return <BlogIndexPage supportEmail={supportEmail} />;
}
