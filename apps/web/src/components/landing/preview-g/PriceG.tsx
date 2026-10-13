/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { Check } from 'lucide-react';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { PRICE_COMPARE, RISK_REVERSAL } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import { PlanCards } from './PlanCardsG';
import type { LandingData } from './SampleG';
import styles from './g.module.css';

/**
 * Section 4 in one screen on desktop: the "if you hired someone" anchors and "先聊后买" in a narrow column beside
 * the plan cards, so the comparison, the prices and the guarantee are read together. Same server data as the
 * landing page; the recommended plan is marked in gold rather than inverted to black.
 */
export function PriceG({ data, membershipHref }: { data: LandingData; membershipHref: string }) {
  const { pricing, compareRows: rows } = data;
  return (
    <section id="pricing" aria-labelledby="pricing-title" className={cn(styles.section, styles.deferred)}>
      <div className={styles.sectionHead}>
        <h2 id="pricing-title" className={styles.display}>{PRICE_COMPARE.title}</h2>
        {pricing.founderOpen ? (
          <p className={styles.founderLine}>
            前 50 位创始会员，招满为止
            {data.founderSeats !== null ? <span>还剩 {data.founderSeats} 个名额</span> : null}
          </p>
        ) : null}
      </div>

      <div className={styles.priceGrid}>
        <div className={styles.priceSide}>
          {rows.length > 0 ? (
            <div className={styles.compare}>
              <p className={styles.compareLede}>{PRICE_COMPARE.lede}</p>
              <ul>
                {rows.map((row, index) => (
                  <li key={row.sourceId}>
                    <span>{row.label}<sup><a href={`#g-source-${row.sourceId}`} aria-label={`出处 ${index + 1}`}>{index + 1}</a></sup></span>
                    <span>{row.price}</span>
                  </li>
                ))}
              </ul>
              {pricing.proMonthly !== null ? <p className={styles.ownPrice}>{PRICE_COMPARE.ownPrice(formatUsd(pricing.proMonthly))}</p> : null}
            </div>
          ) : null}
          <div className={styles.risk}>
            <p className={styles.riskTitle}>{RISK_REVERSAL.title}</p>
            <ul>{data.risk.map(point => <li key={point.text}><Check size={15} aria-hidden="true" />{point.text}</li>)}</ul>
          </div>
        </div>

        {pricing.cards.length > 0 ? (
          <PlanCards cards={pricing.cards} yearlyBadge={pricing.yearlyBadge} showResult={data.showResult} membershipHref={membershipHref} />
        ) : (
          <p role="status" className={styles.lede}>
            会员方案暂时读不到，请稍后刷新，或先看<Link href="/landing/pricing">价格页</Link>。
          </p>
        )}
      </div>

      {rows.length > 0 ? (
        <div className={styles.sources}>
          <p>{PRICE_COMPARE.sourcesTitle}</p>
          <ol>{rows.map(row => <li key={row.sourceId} id={`g-source-${row.sourceId}`}>{PRICE_COMPARE.sources[row.sourceId]}</li>)}</ol>
        </div>
      ) : null}
    </section>
  );
}
