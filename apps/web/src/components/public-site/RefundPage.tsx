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
import { SITE_CHROME, visibleHref } from './site-chrome';

const TEXT = 'text-base leading-8 text-[#C8C8C8]';

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
      <article className="mx-auto max-w-3xl px-4 py-10 sm:px-6 md:py-14">
        <nav aria-label={chrome.breadcrumbLabel} className="mb-6 text-sm text-[#8A8A8A]">
          <ol className="flex flex-wrap gap-2">
            <li><Link href={visibleHref('/')} className="hover:text-[#FFD700]">{REFUND_PAGE.crumbs[0].name}</Link></li>
            <li className="flex gap-2"><span aria-hidden="true">/</span><span aria-current="page">{REFUND_PAGE.crumbs[1].name}</span></li>
          </ol>
        </nav>
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{REFUND_PAGE.h1}</h1>
        <p className="mt-5 text-lg leading-8 text-[#E6E6E6]">{REFUND_PAGE.lead}</p>
        <p className="mt-5 text-sm text-[#8A8A8A]">
          <Link href={chrome.company[0].href} rel="author" className="underline hover:text-[#FFD700]">{chrome.authorLabel}</Link>
          {' · '}{chrome.updatedLabel} <time dateTime={REFUND_PAGE.updated}>{REFUND_PAGE.updated}</time>
        </p>
        {REFUND_PAGE.sections.map(section => (
          <section key={section.h2} className="mt-12">
            <h2 className="text-2xl font-semibold">{section.h2}</h2>
            <ul className={`mt-4 list-disc space-y-2 pl-6 ${TEXT}`}>
              {section.items.map(item => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ))}
        <p className={`mt-12 border-t border-[#262626] pt-6 ${TEXT}`}>
          {REFUND_PAGE.footnote}<Link href="/terms" className="ml-1 text-[#FFD700] hover:underline">查看服务条款</Link>
          <Link href="/refund-policy" className="ml-3 text-[#FFD700] hover:underline">查看完整退款政策（英文）</Link>
        </p>
      </article>
    </SiteShell>
  );
}
