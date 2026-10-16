/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { depthClass } from '@/components/public-site/motion/depth-text';
import { PRICE_COMPARE, RISK_REVERSAL } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import { PlanCardsH } from './PlanCardsH';
import type { LandingData } from './SampleH';
import { Heading } from './SectionsH';
import styles from './h.module.css';

/**
 * Section 4 in the final copy's order: the "if you hired someone" anchors first (a strip of figures, so $29 is read
 * against them), then the plan cards, then "先聊后买" right under the cards' buttons. Same server data as the landing
 * page; prices roll in like an odometer and the recommended plan carries a slowly turning light edge.
 */
export function PriceH({ data, membershipHref }: { data: LandingData; membershipHref: string }) {
  const { pricing, compareRows: rows } = data;
  return (
    <section id="pricing" aria-labelledby="pricing-title" className={cn(styles.section, styles.deferred)} data-region="价格">
      <div className={styles.sectionHead}>
        <Heading id="pricing-title" text={PRICE_COMPARE.title} />
        {pricing.founderOpen ? (
          <p className={cn(styles.founderLine, depthClass.reveal)} data-reveal="">
            前 50 位创始会员，招满为止
            {data.founderSeats !== null ? <span>还剩 {data.founderSeats} 个名额</span> : null}
          </p>
        ) : null}
      </div>

      <div className={styles.priceGrid}>
        {rows.length > 0 ? (
          <div className={cn(styles.compare, styles.glass, depthClass.reveal)} data-reveal="" data-region="费用对比">
            <p className={styles.compareLede}>{PRICE_COMPARE.lede}</p>
            <ul>
              {rows.map((row, index) => (
                <li key={row.sourceId} className={depthClass.reveal} data-reveal="" style={{ '--d': index } as CSSProperties}>
                  <span>{row.label}<sup><a href={`#h-source-${row.sourceId}`} aria-label={`出处 ${index + 1}`}>{index + 1}</a></sup></span>
                  <span>{row.price}</span>
                </li>
              ))}
            </ul>
            {pricing.proMonthly !== null ? <p className={styles.ownPrice}>{PRICE_COMPARE.ownPrice(formatUsd(pricing.proMonthly))}</p> : null}
          </div>
        ) : null}
        {pricing.cards.length > 0 ? (
          <PlanCardsH cards={pricing.cards} yearlyBadge={pricing.yearlyBadge} showResult={data.showResult} membershipHref={membershipHref} />
        ) : (
          <p role="status" className={styles.lede}>
            会员方案暂时读不到，请稍后刷新，或先看<Link href="/landing/pricing">价格页</Link>。
          </p>
        )}
        <div className={cn(styles.risk, styles.glass, depthClass.reveal)} data-reveal="" data-region="放心承诺" style={{ '--d': 1 } as CSSProperties}>
          <p className={styles.riskTitle}>{RISK_REVERSAL.title}</p>
          <ul>{data.risk.map(point => <li key={point.text}><Check size={15} aria-hidden="true" />{point.text}</li>)}</ul>
        </div>
      </div>

      {rows.length > 0 ? (
        <div className={styles.sources}>
          <p>{PRICE_COMPARE.sourcesTitle}</p>
          <ol>{rows.map(row => <li key={row.sourceId} id={`h-source-${row.sourceId}`}>{PRICE_COMPARE.sources[row.sourceId]}</li>)}</ol>
        </div>
      ) : null}
    </section>
  );
}
