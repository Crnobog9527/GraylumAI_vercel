/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { Check } from 'lucide-react';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { PRICE_COMPARE, RISK_REVERSAL } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import { reveal } from '@/components/public-site/motion/i-reveal';
import { PlanCards } from './PlanCardsI';
import { order, type LandingData } from './shared';
import styles from './i.module.css';

/**
 * Section 4 in one screen on desktop, laid out as sample G's: plan cards first (also first on a phone), the
 * "if you hired someone" anchors and "先聊后买" beside them. Same server data as the landing page; the
 * recommended plan wears a sun-yellow sticker shadow and a tilted "推荐" tag.
 */
export function PriceI({ data, membershipHref }: { data: LandingData; membershipHref: string }) {
  const { pricing, compareRows: rows } = data;
  return (
    <section id="pricing" data-i-reveal="" aria-labelledby="pricing-title" className={cn(reveal.section, styles.section, styles.deferred)}>
      <div className={cn(styles.sectionHead, reveal.rise)}>
        <h2 id="pricing-title" className={styles.display}>{PRICE_COMPARE.title}</h2>
        {pricing.founderOpen ? (
          <p className={styles.founderLine}>
            前 50 位创始会员，招满为止
            {data.founderSeats !== null ? <span>还剩 {data.founderSeats} 个名额</span> : null}
          </p>
        ) : null}
      </div>

      <div className={cn(styles.priceGrid, reveal.rise)} style={order(1)}>
        {pricing.cards.length > 0 ? (
          <PlanCards cards={pricing.cards} yearlyBadge={pricing.yearlyBadge} showResult={data.showResult} membershipHref={membershipHref} />
        ) : (
          <p role="status" className={styles.lede}>
            会员方案暂时读不到，请稍后刷新，或先看<Link href="/landing/pricing">价格页</Link>。
          </p>
        )}
        <div className={styles.priceSide}>
          {rows.length > 0 ? (
            <div className={cn(styles.compare, styles.sticker)}>
              <p className={styles.compareLede}>{PRICE_COMPARE.lede}</p>
              <ul>
                {rows.map((row, index) => (
                  <li key={row.sourceId}>
                    <span>{row.label}<sup><a href={`#i-source-${row.sourceId}`} aria-label={`出处 ${index + 1}`}>{index + 1}</a></sup></span>
                    <span>{row.price}</span>
                  </li>
                ))}
              </ul>
              {pricing.proMonthly !== null ? <p className={styles.ownPrice}>{PRICE_COMPARE.ownPrice(formatUsd(pricing.proMonthly))}</p> : null}
            </div>
          ) : null}
          <div className={cn(styles.risk, styles.sticker)}>
            <p className={styles.riskTitle}>{RISK_REVERSAL.title}</p>
            <ul>{data.risk.map(point => <li key={point.text}><Check size={15} aria-hidden="true" />{point.text}</li>)}</ul>
          </div>
        </div>
      </div>

      {rows.length > 0 ? (
        <div className={styles.sources}>
          <p>{PRICE_COMPARE.sourcesTitle}</p>
          <ol>{rows.map(row => <li key={row.sourceId} id={`i-source-${row.sourceId}`}>{PRICE_COMPARE.sources[row.sourceId]}</li>)}</ol>
        </div>
      ) : null}
    </section>
  );
}
