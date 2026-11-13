/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import Link from 'next/link';
import { OfferFaq } from '@/components/landing/offer/OfferFaq';
import { JsonLd } from '@/components/seo/JsonLd';
import { FAQ_PAGE, faqEntries, faqGroups } from '@/lib/seo/content/faq';
import { breadcrumbJsonLd, faqPageJsonLd, webPageJsonLd } from '@/lib/seo/structured-data';
import { SiteShell } from './SiteShell';
import { SITE_CHROME, visibleHref } from './site-chrome';
import styles from './article.module.css';

/** /faq: the landing page's FAQ on its own page; the FAQPage data is made from the same groups the page shows. */
export function FaqPage({ supportEmail }: { supportEmail?: string | null }) {
  const chrome = SITE_CHROME['zh-Hans'];
  const groups = faqGroups();
  return (
    <SiteShell locale="zh-Hans" supportEmail={supportEmail}>
      <JsonLd data={[
        webPageJsonLd({
          path: FAQ_PAGE.path, title: FAQ_PAGE.metaTitle, description: FAQ_PAGE.metaDescription,
          locale: 'zh-Hans', dateModified: FAQ_PAGE.updated,
        }),
        breadcrumbJsonLd(FAQ_PAGE.breadcrumb),
        faqPageJsonLd(faqEntries(groups)),
      ]} />
      <div className={styles.article} data-wide="">
        <nav aria-label={chrome.breadcrumbLabel} className={styles.crumbs}>
          <ol>
            <li><Link href={visibleHref('/')}>{FAQ_PAGE.breadcrumb[0].name}</Link></li>
            <li><span aria-hidden="true">/</span><span aria-current="page">{FAQ_PAGE.breadcrumb[1].name}</span></li>
          </ol>
        </nav>
        <h1 className={styles.title}>{FAQ_PAGE.h1}</h1>
        <p className={styles.lead}>{FAQ_PAGE.lead}</p>
        <p className={styles.byline}>
          <Link href={chrome.company[0].href} rel="author">{chrome.authorLabel}</Link>
          {' · '}{chrome.updatedLabel} <time dateTime={FAQ_PAGE.updated}>{FAQ_PAGE.updated}</time>
        </p>
        <OfferFaq groups={groups} />
      </div>
    </SiteShell>
  );
}
