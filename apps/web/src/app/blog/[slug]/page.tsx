/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { notFound } from 'next/navigation';
import { ArticlePage } from '@/components/public-site/ArticlePage';
import { getPublicSiteSettings } from '@/lib/public-site';
import { articleMetadata } from '@/lib/seo/article';
import { BLOG_POSTS, findPost } from '@/lib/seo/content/blog';

// Static with hourly refresh (SEO_GEO_SPEC section 9). Only the articles in BLOG_POSTS exist; any other address is a real 404.
export const revalidate = 3600;
export const dynamicParams = false;

export function generateStaticParams() {
  return BLOG_POSTS.map(post => ({ slug: post.path.replace('/blog/', '') }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const post = findPost((await params).slug);
  return post ? articleMetadata(post) : {};
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const post = findPost((await params).slug);
  if (!post) notFound();
  const { supportEmail } = await getPublicSiteSettings();
  return <ArticlePage content={post} supportEmail={supportEmail} />;
}
