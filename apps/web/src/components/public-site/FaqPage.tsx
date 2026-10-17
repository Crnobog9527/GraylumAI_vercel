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
      <div className="mx-auto max-w-3xl px-4 pt-10 sm:px-6 md:pt-14">
        <nav aria-label={chrome.breadcrumbLabel} className="mb-6 text-sm text-[#8A8A8A]">
          <ol className="flex flex-wrap gap-2">
            <li><Link href={visibleHref('/')} className="hover:text-[#FFD700]">{FAQ_PAGE.breadcrumb[0].name}</Link></li>
            <li className="flex gap-2"><span aria-hidden="true">/</span><span aria-current="page">{FAQ_PAGE.breadcrumb[1].name}</span></li>
          </ol>
        </nav>
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{FAQ_PAGE.h1}</h1>
        <p className="mt-5 text-lg leading-8 text-[#E6E6E6]">{FAQ_PAGE.lead}</p>
        <p className="mt-5 text-sm text-[#8A8A8A]">
          <Link href={chrome.company[0].href} rel="author" className="underline hover:text-[#FFD700]">{chrome.authorLabel}</Link>
          {' · '}{chrome.updatedLabel} <time dateTime={FAQ_PAGE.updated}>{FAQ_PAGE.updated}</time>
        </p>
      </div>
      <OfferFaq groups={groups} />
    </SiteShell>
  );
}
