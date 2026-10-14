/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Minus, Star } from 'lucide-react';
import { formatUsd, type PaywallBilling } from '@/components/paywall/paywallPlans';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { J_FOUNDER_BAR, J_PLAN_FEATURES, J_PLAN_LINK } from '@/lib/landing/landing-copy-j-price';
import type { CardQuote, LandingCard, LandingPricing } from '@/lib/landing/landing-pricing';
import { cn } from '@/lib/utils';
import styles from './price-j.module.css';
import page from './j.module.css';

export const PRICING_PAGE = '/landing/pricing';

/** What the J price section needs beyond the shared landing data: read on the server in the preview page. */
export type PriceExtras = {
  founderTotal: number | null;
  founderPrice: number | null;
  credits: Partial<Record<'pro' | 'gold', number>>;
  flags: LandingFlags;
  /** The sample reports: in a local development preview, or when the `sampleReports` flag is on. */
  showSamples?: boolean;
};

/**
 * Paywall v25's founder bar: only while the server says seats are left; before anyone joins it reads "首批开放", after
 * that "已加入 N 位 · 还剩 M" with a meter.
 */
export function FounderBarJ({ left, total, price }: { left: number | null; total: number | null; price: number | null }) {
  if (left === null || left <= 0) return null;
  const joined = total !== null ? Math.max(0, total - left) : 0;
  return (
    <p className={styles.founderBar}>
      <Star size={16} aria-hidden="true" />
      <b>{J_FOUNDER_BAR.title}</b>
      <span className={styles.slots}>
        {joined > 0 && total ? <i className={styles.meter}><i style={{ width: `${Math.round((joined / total) * 100)}%` }} /></i> : null}
        {joined > 0 ? J_FOUNDER_BAR.joined(joined, left) : J_FOUNDER_BAR.fresh(total ?? left)}
      </span>
      {price !== null ? <span className={styles.founderRule}>{J_FOUNDER_BAR.rule(formatUsd(price))}</span> : null}
    </p>
  );
}

/**
 * The billing switch and the Pro and Gold cards (v25's pricing-page cards, shortened): price, who it fits, and what
 * each includes, Gold's extras crossed out on Pro. While founder seats are left, Gold's yearly price is the founder
 * price with the seats left, as v25 shows it (no separate founder card). The whole card leads to the pricing page.
 */
export function PlanCardsJ({ pricing, showResult, founderSeats, extras, sample }: {
  pricing: LandingPricing; showResult: Record<string, boolean>; founderSeats: number | null; extras: PriceExtras; sample: boolean;
}) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  const founder = pricing.cards.find(card => card.key === 'founder');
  const cards = pricing.cards.filter(card => card.key !== 'founder');
  const hasYearly = cards.some(card => card.quotes.yearly);
  return (
    <>
      <FounderBarJ left={founderSeats} total={extras.founderTotal} price={extras.founderPrice} />
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
        {cards.map(card => {
          const founderPrice = card.key === 'gold' && billing === 'yearly' && founder?.quotes.yearly && founderSeats ? founder.quotes.yearly : null;
          const quote = founderPrice ?? card.quotes[billing];
          return (
            <article key={card.key} aria-label={card.name} className={cn(styles.plan, card.recommended && styles.recommended)}>
              {sample ? <span className={styles.sampleTag}>本机示例数据</span> : null}
              <p className={styles.planHead}><b>{card.name}</b>{card.recommended ? <span>推荐</span> : null}</p>
              <p className={styles.planFit}>适合{card.fit}的人</p>
              {quote ? <Price quote={quote} founder={founderPrice ? founderSeats : null} /> : (
                <p className={styles.planNote}>{card.missingNote[billing] ?? '暂不提供'}</p>
              )}
              {showResult[card.key] ? <p className={styles.planResult}>{card.result.text}</p> : null}
              <Features card={card} extras={extras} />
              <Link href={PRICING_PAGE} className={cn(card.recommended ? page.pill : styles.planButton, styles.cardLink)}>
                {J_PLAN_LINK.cta(card.name)}
              </Link>
              {quote ? <p className={styles.planNote}>{quote.renewal}</p> : null}
            </article>
          );
        })}
      </div>
    </>
  );
}

function Price({ quote, founder }: { quote: CardQuote; founder: number | null }) {
  return (
    <div className={styles.priceBlock}>
      {founder !== null || quote.tag ? <span className={styles.planTag}>{founder !== null ? J_FOUNDER_BAR.goldTag : quote.tag}</span> : null}
      <p className={styles.planPrice}>{quote.strike ? <s>{quote.strike}</s> : null}<b>{quote.price}</b><span>{quote.per}</span></p>
      {quote.saving || founder !== null ? (
        <p className={styles.saving}>{[quote.saving, founder !== null ? J_FOUNDER_BAR.seatsLeft(founder) : null].filter(Boolean).join(' · ')}</p>
      ) : null}
    </div>
  );
}

function Features({ card, extras }: { card: LandingCard; extras: PriceExtras }) {
  const tier = card.key === 'gold' ? 'gold' : 'pro';
  const credits = extras.credits[tier];
  return (
    <div className={styles.features}>
      {J_PLAN_FEATURES.map(group => {
        const items = group.items
          .filter(item => allOn(extras.flags, item.needs))
          .filter(item => !(item.gold.includes('{credits}') && credits === undefined));
        if (items.length === 0) return null;
        return (
          <div key={group.group}>
            <p className={styles.featureGroup}>{group.group}</p>
            <ul>
              {items.map(item => {
                const text = (item[tier] ?? item.gold).replace('{credits}', credits?.toLocaleString('en-US') ?? '');
                const on = item[tier] !== null;
                return (
                  <li key={item.gold} data-off={on ? undefined : ''}>
                    {on ? <Check size={15} aria-hidden="true" /> : <Minus size={15} aria-hidden="true" />}
                    <span>{on ? null : <span className="sr-only">不包含：</span>}{text}{item.soon ? <em>即将上线</em> : null}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
