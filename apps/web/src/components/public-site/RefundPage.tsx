/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import Link from 'next/link';
import { JsonLd } from '@/components/seo/JsonLd';
import { REFUND_PAGE } from '@/lib/seo/content/refund';
import { breadcrumbJsonLd, webPageJsonLd } from '@/lib/seo/structured-data';
import { SiteShell } from './SiteShell';
import { sectionZone } from './ArticlePage';
import { SITE_CHROME, visibleHref } from './site-chrome';
import styles from './article.module.css';

/** The public refund summary (/refund): one H1, the answer first, rules as plain lists, and the pointer to the full terms. */
export function RefundPage({ supportEmail }: { supportEmail?: string | null }) {
  const chrome = SITE_CHROME['zh-Hans'];
  return (
    <SiteShell locale="zh-Hans" supportEmail={supportEmail}>
      <JsonLd data={[
        webPageJsonLd({
          path: REFUND_PAGE.path, title: REFUND_PAGE.metaTitle, description: REFUND_PAGE.metaDescription,
          locale: 'zh-Hans', dateModified: REFUND_PAGE.updated,
        }),
        breadcrumbJsonLd([...REFUND_PAGE.crumbs]),
      ]} />
      <article className={styles.article}>
        <nav aria-label={chrome.breadcrumbLabel} className={styles.crumbs}>
          <ol>
            <li><Link href={visibleHref('/')}>{REFUND_PAGE.crumbs[0].name}</Link></li>
            <li><span aria-hidden="true">/</span><span aria-current="page">{REFUND_PAGE.crumbs[1].name}</span></li>
          </ol>
        </nav>
        <h1 className={styles.title}>{REFUND_PAGE.h1}</h1>
        <p className={styles.lead}>{REFUND_PAGE.lead}</p>
        <p className={styles.byline}>
          <Link href={chrome.company[0].href} rel="author">{chrome.authorLabel}</Link>
          {' · '}{chrome.updatedLabel} <time dateTime={REFUND_PAGE.updated}>{REFUND_PAGE.updated}</time>
        </p>
        {REFUND_PAGE.sections.map((section, index) => (
          <section key={section.h2} className={styles.section} data-zone={sectionZone(index)}>
            <h2>{section.h2}</h2>
            <ul className={styles.list}>
              {section.items.map(item => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ))}
        <p className={styles.foot} data-zone="final">
          {REFUND_PAGE.footnote}<Link href="/terms" className={`${styles.textLink} ${styles.footLink}`}>查看服务条款</Link>
          <Link href="/refund-policy" className={styles.textLink}>查看完整退款政策（英文）</Link>
        </p>
      </article>
    </SiteShell>
  );
}
