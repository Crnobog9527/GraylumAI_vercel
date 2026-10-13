/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { Check } from 'lucide-react';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { PRICE_COMPARE, RISK_REVERSAL } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import { PriceCardsD } from './PriceCardsD';
import type { LandingData } from './SampleD';
import styles from './d.module.css';

/**
 * Section 4: the one-word heading set at poster size, the "if you hired someone" anchors as a ruled sheet,
 * then the cards as columns of one board and "先聊后买" right under them. Same server data as the landing page.
 */
export function PriceD({ data, membershipHref }: { data: LandingData; membershipHref: string }) {
  const { pricing, compareRows: rows } = data;
  return (
    <section id="pricing" aria-labelledby="pricing-title" className={cn(styles.section, styles.deferred)}>
      <div className={styles.priceHead}>
      <h2 id="pricing-title" className={cn(styles.display, styles.priceTitle)}>{PRICE_COMPARE.title}</h2>

      {rows.length > 0 ? (
        <div className={cn(styles.compare, styles.ticked)}>
          <p className={styles.compareLede}>{PRICE_COMPARE.lede}</p>
          <ul>
            {rows.map((row, index) => (
              <li key={row.sourceId}><span>{row.label}<sup><a href={`#d-source-${row.sourceId}`} aria-label={`出处 ${index + 1}`}>{index + 1}</a></sup></span><span>{row.price}</span></li>
            ))}
          </ul>
          {pricing.proMonthly !== null ? <p className={styles.ownPrice}>{PRICE_COMPARE.ownPrice(formatUsd(pricing.proMonthly))}</p> : null}
        </div>
      ) : null}
      </div>

      {pricing.founderOpen ? (
        <p className={styles.founderLine}>
          前 50 位创始会员，招满为止
          {data.founderSeats !== null ? <span>还剩 {data.founderSeats} 个名额</span> : null}
        </p>
      ) : null}

      {pricing.cards.length > 0 ? (
        <PriceCardsD cards={pricing.cards} yearlyBadge={pricing.yearlyBadge} showResult={data.showResult} membershipHref={membershipHref} />
      ) : (
        <p role="status" className={cn(styles.lede, styles.plansMissing)}>
          会员方案暂时读不到，请稍后刷新，或先看<Link href="/landing/pricing">价格页</Link>。
        </p>
      )}

      <div className={styles.risk}>
        <p className={styles.riskTitle}>{RISK_REVERSAL.title}</p>
        <ul>{data.risk.map(point => <li key={point.text}><Check size={16} aria-hidden="true" />{point.text}</li>)}</ul>
      </div>

      {rows.length > 0 ? (
        <div className={styles.sources}>
          <p>{PRICE_COMPARE.sourcesTitle}</p>
          <ol>{rows.map(row => <li key={row.sourceId} id={`d-source-${row.sourceId}`}>{PRICE_COMPARE.sources[row.sourceId]}</li>)}</ol>
        </div>
      ) : null}
    </section>
  );
}
