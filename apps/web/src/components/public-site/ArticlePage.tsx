/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import Link from 'next/link';
import { JsonLd } from '@/components/seo/JsonLd';
import type { ArticleBlock, ArticleContent } from '@/lib/seo/article';
import { breadcrumbJsonLd, faqPageJsonLd, webPageJsonLd } from '@/lib/seo/structured-data';
import { SiteShell } from './SiteShell';
import { SITE_CHROME } from './site-chrome';

const TEXT = 'text-base leading-8 text-[#C8C8C8]';

function Block({ block }: { block: ArticleBlock }) {
  return (
    <>
      {block.paragraphs.map(paragraph => (
        <p key={paragraph} className={`mt-4 ${TEXT}`}>{paragraph}</p>
      ))}
      {block.list?.length ? (
        <ul className={`mt-4 list-disc space-y-2 pl-6 ${TEXT}`}>
          {block.list.map(item => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
    </>
  );
}

/**
 * One public keyword or info page (SEO_GEO_SPEC sections 6–8 and 10): a single H1 with the answer on the
 * first screen, a product entry, H2 questions with H3 details, visible FAQ, related links, date and author.
 */
export function ArticlePage({ content, supportEmail }: { content: ArticleContent; supportEmail?: string | null }) {
  const chrome = SITE_CHROME[content.locale];
  const aboutHref = chrome.company[0].href;
  const jsonLd = [
    webPageJsonLd({
      path: content.path,
      title: content.metaTitle,
      description: content.metaDescription,
      locale: content.locale,
      dateModified: content.updated,
    }),
    breadcrumbJsonLd(content.breadcrumb),
    ...(content.faq?.length ? [faqPageJsonLd(content.faq)] : []),
  ];

  return (
    <SiteShell locale={content.locale} alternates={content.alternates} supportEmail={supportEmail}>
      <JsonLd data={jsonLd} />
      <article className="mx-auto max-w-3xl px-4 py-10 sm:px-6 md:py-14">
        {content.breadcrumb.length > 1 ? (
          <nav aria-label={chrome.breadcrumbLabel} className="mb-6 text-sm text-[#8A8A8A]">
            <ol className="flex flex-wrap gap-2">
              {content.breadcrumb.map((item, index) => (
                <li key={item.path} className="flex gap-2">
                  {index > 0 ? <span aria-hidden="true">/</span> : null}
                  {index < content.breadcrumb.length - 1
                    ? <Link href={item.path} className="hover:text-[#FFD700]">{item.name}</Link>
                    : <span aria-current="page">{item.name}</span>}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{content.h1}</h1>
        <p className="mt-5 text-lg leading-8 text-[#E6E6E6]">{content.lead}</p>
        {content.keyPoints?.length ? (
          <ul className={`mt-5 list-disc space-y-2 pl-6 ${TEXT}`}>
            {content.keyPoints.map(point => <li key={point}>{point}</li>)}
          </ul>
        ) : null}
        <p className="mt-5 text-sm text-[#8A8A8A]">
          {chrome.authorLabel} · {chrome.updatedLabel} <time dateTime={content.updated}>{content.updated}</time> ·{' '}
          <Link href={aboutHref} className="underline hover:text-[#FFD700]">{chrome.aboutLabel}</Link>
        </p>

        <div className="mt-8 rounded-2xl border border-[#FFD700]/30 bg-[#141414] p-6">
          <p className={TEXT}>{content.cta.description}</p>
          <Link
            href={content.cta.href}
            className="mt-4 inline-block rounded-lg bg-[#FFD700] px-5 py-3 text-sm font-semibold text-[#0A0A0A] hover:bg-[#FFE34D]"
          >
            {content.cta.label}
          </Link>
        </div>

        {content.definition ? (
          <section className="mt-10 border-l-2 border-[#FFD700] pl-5">
            <p className={TEXT}><strong className="text-white">{content.definition.term}</strong>{content.definition.text}</p>
          </section>
        ) : null}

        {content.sections.map(section => (
          <section key={section.h2} className="mt-12">
            <h2 className="text-2xl font-semibold">{section.h2}</h2>
            <Block block={section} />
            {section.subsections?.map(subsection => (
              <div key={subsection.h3} className="mt-6">
                <h3 className="text-lg font-semibold text-white">{subsection.h3}</h3>
                <Block block={subsection} />
              </div>
            ))}
          </section>
        ))}

        {content.faq?.length ? (
          <section className="mt-12">
            <h2 className="text-2xl font-semibold">{chrome.faqTitle}</h2>
            {content.faq.map(item => (
              <div key={item.question} className="mt-6">
                <h3 className="text-lg font-semibold text-white">{item.question}</h3>
                <p className={`mt-3 ${TEXT}`}>{item.answer}</p>
              </div>
            ))}
          </section>
        ) : null}

        <section className="mt-12">
          <h2 className="text-2xl font-semibold">{chrome.relatedTitle}</h2>
          <ul className="mt-4 space-y-4">
            {content.related.map(link => (
              <li key={link.href}>
                <Link href={link.href} className="font-semibold text-[#FFD700] hover:underline">{link.label}</Link>
                <p className="mt-1 text-sm leading-7 text-[#9A9A9A]">{link.description}</p>
              </li>
            ))}
          </ul>
        </section>
      </article>
    </SiteShell>
  );
}
