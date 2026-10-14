/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { PRICE_COMPARE, RISK_REVERSAL, type CompareRow, type GatedText } from '@/lib/landing/landing-copy';
import { J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import type { LandingPricing } from '@/lib/landing/landing-pricing';
import { cn } from '@/lib/utils';
import { PlanCardsJ, PRICING_PAGE, type PriceExtras } from './PlanCardsJ';
import styles from './price-j.module.css';
import page from './j.module.css';

/**
 * Price (Owner 2026-10-15, round three): what the usual ways cost, each figure with its source beside it, then their
 * total, ending on "Graylum AI：$29/月起"; paywall v25's founder bar while seats are left; the Pro and Gold cards with
 * what each includes, every card leading to the full pricing page (no direct checkout here); then "先聊后买". Every
 * price and seat count comes from the server (landing-pricing.ts, getLandingOffers).
 */
export function PriceJ({ pricing, rows, risk, showResult, founderSeats, extras, sample = false }: {
  pricing: LandingPricing; rows: readonly CompareRow[]; risk: readonly GatedText[]; showResult: Record<string, boolean>;
  founderSeats: number | null; extras: PriceExtras;
  /** Local preview only: the prices are the fixed samples of lib/dev/local-sample-pricing.ts. */
  sample?: boolean;
}) {
  const allRows = J_PRICE_TOTAL.rows.every(id => rows.some(row => row.sourceId === id));
  return (
    <section id="pricing" aria-labelledby="pricing-title" className={page.section} data-zone="price">
      <div className={page.wrap}>
        <h2 id="pricing-title" className={page.display}>{J_PRICE.title}</h2>

        {rows.length > 0 ? (
          <div className={styles.compareCost}>
            <h3>{J_PRICE.compareTitle}</h3>
            <ul>
              {rows.map(row => (
                <li key={row.sourceId}>
                  <span>{row.label}</span>
                  <b>{row.price}</b>
                  <small>{J_PRICE.sourceLabel}：{PRICE_COMPARE.sources[row.sourceId]}</small>
                </li>
              ))}
              {allRows ? <li className={styles.total}><span>{J_PRICE_TOTAL.label}</span><b>{J_PRICE_TOTAL.text}</b></li> : null}
              {pricing.proMonthly !== null ? <li className={styles.own}><b>{J_PRICE.ownPrice(formatUsd(pricing.proMonthly))}</b></li> : null}
            </ul>
            <p className={styles.checked}>{J_PRICE.checked}</p>
          </div>
        ) : null}

        {pricing.cards.length > 0
          ? <PlanCardsJ pricing={pricing} showResult={showResult} founderSeats={founderSeats} extras={extras} sample={sample} />
          : <p role="status" className={cn(page.lede, styles.unavailable)}>{J_PRICE.unavailable}</p>}

        <div className={styles.risk}>
          <h3>{RISK_REVERSAL.title}</h3>
          <ul>{risk.map(point => <li key={point.text}><Check size={16} aria-hidden="true" />{point.text}</li>)}</ul>
        </div>
        <Link href={PRICING_PAGE} className={styles.more}>{J_PRICE.more}<ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    </section>
  );
}
