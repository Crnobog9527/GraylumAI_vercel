/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { PRICE_COMPARE, RISK_REVERSAL } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE } from '@/lib/landing/landing-faq';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { cn } from '@/lib/utils';
import { CountUp } from './CountUp';
import { FPriceCards } from './FPriceCards';
import styles from './sample-f.module.css';

type Data = ReturnType<typeof buildLandingPageData>;

/** Price section (offer section 4) in sample F: an oversized sticky title beside the comparison, cards and guarantee. */
export function FPrice({ data, membershipHref }: { data: Data; membershipHref: string }) {
  const { pricing, compareRows: rows } = data;
  return (
    <section id="pricing" aria-labelledby="f-pricing-title" className={cn(styles.section, styles.deferred)}>
      <div className={cn(styles.wrap, styles.priceGrid)}>
        <h2 id="f-pricing-title" className={cn(styles.h2, styles.priceTitle, styles.sticky)}>{PRICE_COMPARE.title}</h2>
        <div className={styles.priceStack}>
          {rows.length > 0 ? (
            <div className={cn(styles.card, styles.compare)}>
              <p className={styles.compareLede}>{PRICE_COMPARE.lede}</p>
              <ul>
                {rows.map((row, index) => (
                  <li key={row.sourceId}>
                    <span>{row.label}<sup>{index + 1}</sup></span>
                    <span><CountUp text={row.price} /></span>
                  </li>
                ))}
              </ul>
              {pricing.proMonthly !== null ? <p className={styles.own}>{PRICE_COMPARE.ownPrice(formatUsd(pricing.proMonthly))}</p> : null}
            </div>
          ) : null}
          {pricing.founderOpen ? (
            <p className={styles.founder}>
              前 50 位创始会员，招满为止
              {data.founderSeats !== null ? <span>还剩 {data.founderSeats} 个名额</span> : null}
            </p>
          ) : null}
          {pricing.cards.length > 0 ? (
            <FPriceCards cards={pricing.cards} yearlyBadge={pricing.yearlyBadge} showResult={data.showResult} membershipHref={membershipHref} />
          ) : (
            <p role="status" className={styles.lede}>
              会员方案暂时读不到，请稍后刷新，或先看<Link href="/landing/pricing">价格页</Link>。
            </p>
          )}
          <div className={styles.risk}>
            <p>{RISK_REVERSAL.title}</p>
            <ul>{data.risk.map(point => <li key={point.text}>{point.text}</li>)}</ul>
          </div>
          {rows.length > 0 ? (
            <div className={styles.sources}>
              <p>{PRICE_COMPARE.sourcesTitle}</p>
              <ol>{rows.map(row => <li key={row.sourceId}>{PRICE_COMPARE.sources[row.sourceId]}</li>)}</ol>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** FAQ in sample F: the same three groups as native <details> (answers stay in the HTML, matching the JSON-LD). */
export function FFaq({ groups }: { groups: Data['faqGroups'] }) {
  if (groups.length === 0) return null;
  return (
    <section id="faq" aria-labelledby="f-faq-title" className={cn(styles.section, styles.deferred)}>
      <div className={cn(styles.wrap, styles.priceGrid)}>
        <h2 id="f-faq-title" className={cn(styles.h2, styles.sticky)}>{LANDING_FAQ_TITLE}</h2>
        <div>
          {groups.map(group => (
            <div key={group.title} className={styles.faqGroup}>
              <h3 className={styles.label}>{group.title}</h3>
              {group.items.map(item => (
                <details key={item.id} id={item.id} className={styles.faqItem}>
                  <summary><span>{item.question}</span><Plus size={20} aria-hidden="true" /></summary>
                  <div className={styles.faqAnswer}>{item.answer.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
                </details>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
