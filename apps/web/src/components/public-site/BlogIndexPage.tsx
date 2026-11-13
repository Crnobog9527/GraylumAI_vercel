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
import styles from './article.module.css';

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
      <div className={styles.article}>
        <h1 className={styles.title}>{BLOG_INDEX.h1}</h1>
        <p className={styles.lead}>{BLOG_INDEX.lead}</p>
        <p className={styles.byline}>
          <Link href={chrome.company[0].href} rel="author">{chrome.authorLabel}</Link>
          {' · '}{chrome.updatedLabel} <time dateTime={BLOG_INDEX.updated}>{BLOG_INDEX.updated}</time>
        </p>
        <section className={styles.section} data-zone="voice">
          <h2>最新教程</h2>
          <ul className={styles.cards}>
            {BLOG_POSTS.map(post => (
              <li key={post.path} className={styles.card}>
                <p className={styles.cardTitle}>
                  <Link href={post.path}>{post.h1}</Link>
                </p>
                <p className={styles.text}>{post.lead}</p>
                <p className={styles.meta}><time dateTime={post.published}>{post.published}</time></p>
              </li>
            ))}
          </ul>
        </section>
        <p className={styles.foot} data-zone="final">
          想先看看产品能做什么？<Link href="/features" className={styles.textLink}>功能介绍</Link>
          介绍每一项功能；已有产品界面的功能，页面里配有真实界面的示例。
        </p>
      </div>
    </SiteShell>
  );
}
