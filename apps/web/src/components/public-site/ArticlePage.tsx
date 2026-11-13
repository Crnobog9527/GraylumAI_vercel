/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { JsonLd } from '@/components/seo/JsonLd';
import type { ArticleBlock, ArticleContent } from '@/lib/seo/article';
import { blogPostingJsonLd, breadcrumbJsonLd, faqPageJsonLd, softwareApplicationJsonLd, webPageJsonLd } from '@/lib/seo/structured-data';
import { SiteShell } from './SiteShell';
import { SITE_CHROME, visibleHref } from './site-chrome';
import styles from './article.module.css';

function Block({ block }: { block: ArticleBlock }) {
  return (
    <>
      {block.paragraphs.map(paragraph => (
        <p key={paragraph} className={styles.text}>{paragraph}</p>
      ))}
      {block.list?.length ? (
        <ul className={styles.list}>
          {block.list.map(item => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
    </>
  );
}

/** The zones the backdrop's light moves through down a page (backdrop-j.module.css), one per section in turn. */
export const SECTION_ZONES = ['voice', 'work', 'compare', 'price', 'faq'] as const;
export const sectionZone = (index: number) => SECTION_ZONES[index % SECTION_ZONES.length];

/**
 * One public keyword or info page (SEO_GEO_SPEC sections 6–8 and 10): a single H1 with the answer on the
 * first screen, a product entry, H2 questions with H3 details, visible FAQ, related links, date and author.
 */
export function ArticlePage({ content, supportEmail, demo }: {
  content: ArticleContent;
  supportEmail?: string | null;
  // The product screen shown under the first-screen answer (feature pages); the text above and below stays server-rendered.
  demo?: ReactNode;
}) {
  const chrome = SITE_CHROME[content.locale];
  const aboutHref = chrome.company[0].href;
  const jsonLd = [
    content.published
      ? blogPostingJsonLd({
        path: content.path,
        title: content.h1,
        description: content.metaDescription,
        locale: content.locale,
        published: content.published,
        modified: content.updated,
        authorName: chrome.authorLabel,
        authorPath: aboutHref,
      })
      : webPageJsonLd({
        path: content.path,
        title: content.metaTitle,
        description: content.metaDescription,
        locale: content.locale,
        dateModified: content.updated,
      }),
    ...(content.product
      ? [softwareApplicationJsonLd({ description: content.metaDescription, path: content.path })]
      : []),
    breadcrumbJsonLd(content.breadcrumb),
    ...(content.faq?.length ? [faqPageJsonLd(content.faq)] : []),
  ];

  return (
    <SiteShell locale={content.locale} alternates={content.alternates} supportEmail={supportEmail}>
      <JsonLd data={jsonLd} />
      <article className={styles.article} data-wide={demo ? '' : undefined}>
        {content.breadcrumb.length > 1 ? (
          <nav aria-label={chrome.breadcrumbLabel} className={styles.crumbs}>
            <ol>
              {content.breadcrumb.map((item, index) => (
                <li key={item.path}>
                  {index > 0 ? <span aria-hidden="true">/</span> : null}
                  {index < content.breadcrumb.length - 1
                    ? <Link href={visibleHref(item.path)}>{item.name}</Link>
                    : <span aria-current="page">{item.name}</span>}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        <h1 className={styles.title}>{content.h1}</h1>
        <p className={styles.lead}>{content.lead}</p>
        {content.keyPoints?.length ? (
          <ul className={styles.list}>
            {content.keyPoints.map(point => <li key={point}>{point}</li>)}
          </ul>
        ) : null}
        <p className={styles.byline}>
          <Link href={aboutHref} rel="author">{chrome.authorLabel}</Link>
          {' · '}{chrome.updatedLabel} <time dateTime={content.updated}>{content.updated}</time>
        </p>

        <div className={styles.card}>
          <p className={styles.cardText}>{content.cta.description}</p>
          <div className={styles.cardAction}>
            <Link href={content.cta.href} className={styles.pill}>{content.cta.label}</Link>
          </div>
        </div>

        {demo ? <div className={styles.demo}>{demo}</div> : null}

        {content.definition ? (
          <section className={styles.definition}>
            <p><strong>{content.definition.term}</strong>{content.definition.text}</p>
          </section>
        ) : null}

        {content.sections.map((section, index) => (
          <section key={section.h2} className={styles.section} data-zone={sectionZone(index)}>
            <h2>{section.h2}</h2>
            <Block block={section} />
            {section.table ? (
              // A phone (under 640px; Owner 2026-11-12, phone plan A): each row is a card, what is compared, then every column's
              // answer under that column's name. From 640px it is the table. Same words.
              <div className={styles.tableWrap} role="region" aria-label="对比表格" tabIndex={0}>
                <table className={styles.table}>
                  <caption className="sr-only">{section.table.caption}</caption>
                  <thead>
                    <tr>{section.table.head.map(cell => <th key={cell} scope="col">{cell}</th>)}</tr>
                  </thead>
                  <tbody>
                    {section.table.rows.map(row => (
                      <tr key={row[0]}>
                        {row.map((cell, cellIndex) => cellIndex === 0
                          ? <th key={cell} scope="row">{cell}</th>
                          : <td key={cell}><span className={styles.cellHead}>{section.table!.head[cellIndex]}</span>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {section.subsections?.map(subsection => (
              <div key={subsection.h3} className={styles.sub}>
                <h3>{subsection.h3}</h3>
                <Block block={subsection} />
              </div>
            ))}
          </section>
        ))}

        {content.faq?.length ? (
          <section className={styles.section} data-zone="faq">
            <h2>{chrome.faqTitle}</h2>
            {content.faq.map(item => (
              <div key={item.question} className={styles.faqItem}>
                <h3 className={styles.h3}>{item.question}</h3>
                <p>{item.answer}</p>
              </div>
            ))}
          </section>
        ) : null}

        <section className={styles.section} data-zone="final">
          <h2>{chrome.relatedTitle}</h2>
          <ul className={styles.related}>
            {content.related.map(link => (
              <li key={link.href}>
                <Link href={visibleHref(link.href)}>{link.label}</Link>
                <p>{link.description}</p>
              </li>
            ))}
          </ul>
        </section>

        {content.sources?.length ? (
          <aside className={styles.sources}>
            <p>{chrome.sourcesTitle}</p>
            <ul>
              {content.sources.map(source => (
                <li key={source.href}>
                  <a href={source.href} target="_blank" rel="noopener noreferrer">{source.label}</a>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}
      </article>
    </SiteShell>
  );
}
