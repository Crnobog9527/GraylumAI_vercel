/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import Link from 'next/link';
import { JsonLd } from '@/components/seo/JsonLd';
import { BLOG_INDEX, BLOG_POSTS } from '@/lib/seo/content/blog';
import { breadcrumbJsonLd, webPageJsonLd } from '@/lib/seo/structured-data';
import { SiteShell } from './SiteShell';
import { SITE_CHROME } from './site-chrome';

/** The tutorial list (/blog): one H1, each article as a card with its date; articles link onward to feature pages. */
export function BlogIndexPage({ supportEmail }: { supportEmail?: string | null }) {
  const chrome = SITE_CHROME['zh-Hans'];
  return (
    <SiteShell locale="zh-Hans" supportEmail={supportEmail}>
      <JsonLd data={[
        webPageJsonLd({
          path: BLOG_INDEX.path, title: BLOG_INDEX.metaTitle, description: BLOG_INDEX.metaDescription,
          locale: 'zh-Hans', dateModified: BLOG_INDEX.updated,
        }),
        breadcrumbJsonLd(BLOG_INDEX.breadcrumb),
      ]} />
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 md:py-14">
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{BLOG_INDEX.h1}</h1>
        <p className="mt-5 text-lg leading-8 text-[#E6E6E6]">{BLOG_INDEX.lead}</p>
        <p className="mt-5 text-sm text-[#8A8A8A]">
          <Link href={chrome.company[0].href} rel="author" className="underline hover:text-[#FFD700]">{chrome.authorLabel}</Link>
          {' · '}{chrome.updatedLabel} <time dateTime={BLOG_INDEX.updated}>{BLOG_INDEX.updated}</time>
        </p>
        <h2 className="mt-10 text-2xl font-semibold">最新教程</h2>
        <ul className="mt-6 space-y-6">
          {BLOG_POSTS.map(post => (
            <li key={post.path} className="rounded-2xl border border-[#2B2B2B] bg-[#141414] p-6">
              <p className="text-xl font-semibold">
                <Link href={post.path} className="hover:text-[#FFD700]">{post.h1}</Link>
              </p>
              <p className="mt-3 text-base leading-8 text-[#C8C8C8]">{post.lead}</p>
              <p className="mt-3 text-sm text-[#8A8A8A]"><time dateTime={post.published}>{post.published}</time></p>
            </li>
          ))}
        </ul>
        <p className="mt-10 text-base leading-8 text-[#C8C8C8]">
          想先看看产品能做什么？<Link href="/features" className="font-semibold text-[#FFD700] underline underline-offset-2">功能介绍</Link>
          介绍每一项功能；已有产品界面的功能，页面里配有真实界面的示例。
        </p>
      </div>
    </SiteShell>
  );
}
