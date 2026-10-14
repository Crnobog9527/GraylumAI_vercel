/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { purchaseHref } from '@/components/landing/offer/PriceCards';
import { formatUsd, type PaywallBilling } from '@/components/paywall/paywallPlans';
import { FINAL_ACTION, PRICE_COMPARE, RISK_REVERSAL, type CompareRow, type GatedText } from '@/lib/landing/landing-copy';
import { J_PRICE } from '@/lib/landing/landing-copy-j';
import type { LandingPricing } from '@/lib/landing/landing-pricing';
import { cn } from '@/lib/utils';
import styles from './sections-j.module.css';
import page from './j.module.css';

const PRICING_PAGE = '/landing/pricing';

/**
 * Price, in the order the diagnosis restored: first what the usual ways cost (each figure with its source right
 * beside it, not in footnotes), ending on "Graylum AI：$29/月起"; then the plan cards in the paywall's final form,
 * kept short, each button going straight to buying that plan (#987's links); then "先聊后买" right under them and
 * the way to the full pricing page. Every number comes from the server (landing-pricing.ts, getLandingOffers).
 */
export function PriceJ({ pricing, rows, risk, showResult, founderSeats, membershipHref, sample = false }: {
  pricing: LandingPricing; rows: readonly CompareRow[]; risk: readonly GatedText[]; showResult: Record<string, boolean>;
  founderSeats: number | null; membershipHref: string;
  /** Local preview only: the prices are the fixed samples of lib/dev/local-sample-pricing.ts. */
  sample?: boolean;
}) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  const hasYearly = pricing.cards.some(card => card.quotes.yearly);
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
              {pricing.proMonthly !== null ? <li className={styles.own}><b>{J_PRICE.ownPrice(formatUsd(pricing.proMonthly))}</b></li> : null}
            </ul>
            <p className={styles.checked}>{J_PRICE.checked}</p>
          </div>
        ) : null}

        {pricing.founderOpen ? (
          <p className={styles.founder}>{FINAL_ACTION.founderLine}{founderSeats !== null ? <span>还剩 {founderSeats} 个名额</span> : null}</p>
        ) : null}

        {pricing.cards.length > 0 ? (
          <>
            <div role="radiogroup" aria-label="计费周期" className={styles.billing}>
              {(['monthly', 'yearly'] as const).map(cycle => (
                <label key={cycle} data-on={billing === cycle || undefined} data-disabled={(cycle === 'yearly' && !hasYearly) || undefined}>
                  <input type="radio" name="j-billing" className="sr-only" value={cycle} checked={billing === cycle}
                    disabled={cycle === 'yearly' && !hasYearly} onChange={() => setBilling(cycle)} />
                  {cycle === 'monthly' ? '月付' : '年付'}
                  {cycle === 'yearly' && pricing.yearlyBadge ? <span>{pricing.yearlyBadge}</span> : null}
                </label>
              ))}
            </div>
            <div className={styles.plans}>
              {pricing.cards.map(card => {
                const quote = card.quotes[billing];
                const ready = card.checkoutReady[billing];
                return (
                  <article key={card.key} aria-label={card.name} className={cn(styles.plan, card.recommended && styles.recommended)}>
                    {sample ? <span className={styles.sampleTag}>本机示例数据</span> : null}
                    <p className={styles.planHead}><b>{card.name}</b>{card.recommended ? <span>推荐</span> : null}</p>
                    {showResult[card.key] ? <p className={styles.planResult}>{card.result.text}</p> : null}
                    {quote ? (
                      <>
                        {quote.tag ? <span className={styles.planTag}>{quote.tag}</span> : null}
                        <p className={styles.planPrice}>{quote.strike ? <s>{quote.strike}</s> : null}<b>{quote.price}</b><span>{quote.per}</span></p>
                        <Link href={ready ? purchaseHref(membershipHref, card.key, billing) : '/contact'}
                          className={card.recommended ? page.pill : styles.planButton}>
                          {ready ? card.cta : '联系我们'}
                        </Link>
                        <p className={styles.planNote}>{quote.renewal}</p>
                      </>
                    ) : <p className={styles.planNote}>{card.missingNote[billing] ?? '暂不提供'}</p>}
                    <p className={styles.planFit}>适合：{card.fit}</p>
                  </article>
                );
              })}
            </div>
          </>
        ) : <p role="status" className={cn(page.lede, styles.unavailable)}>{J_PRICE.unavailable}</p>}

        <div className={styles.risk}>
          <h3>{RISK_REVERSAL.title}</h3>
          <ul>{risk.map(point => <li key={point.text}><Check size={16} aria-hidden="true" />{point.text}</li>)}</ul>
        </div>
        <Link href={PRICING_PAGE} className={styles.more}>{J_PRICE.more}<ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    </section>
  );
}
