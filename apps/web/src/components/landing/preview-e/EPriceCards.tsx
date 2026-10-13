/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { PaywallBilling } from '@/components/paywall/paywallPlans';
import type { LandingCard } from '@/lib/landing/landing-pricing';
import { cn } from '@/lib/utils';
import { CountUp } from './CountUp';
import styles from './e.module.css';

/**
 * Monthly / yearly switch and the price cards (same data and wording as the landing page's PriceCards); the
 * recommended plan is the dark card. Cards and every number come from the server (landing-pricing.ts).
 */
export function EPriceCards({ cards, yearlyBadge, showResult, membershipHref }: {
  cards: readonly LandingCard[];
  yearlyBadge: string | null;
  showResult: Record<string, boolean>;
  membershipHref: string;
}) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  const hasYearly = cards.some(card => card.quotes.yearly);

  return (
    <div>
      <div role="radiogroup" aria-label="计费周期" className={styles.billing}>
        {(['monthly', 'yearly'] as const).map(cycle => {
          const disabled = cycle === 'yearly' && !hasYearly;
          return (
            <label key={cycle} data-on={billing === cycle} data-disabled={disabled}>
              <input type="radio" name="preview-e-billing" className="sr-only" value={cycle} checked={billing === cycle}
                disabled={disabled} onChange={() => setBilling(cycle)} />
              {cycle === 'monthly' ? '月付' : '年付'}
              {cycle === 'yearly' && yearlyBadge ? <span className={styles.badge}>{yearlyBadge}</span> : null}
            </label>
          );
        })}
      </div>
      <div className={styles.cards}>
        {cards.map(card => (
          <PriceCard key={card.key} card={card} billing={billing} showResult={showResult[card.key] === true} membershipHref={membershipHref} />
        ))}
      </div>
    </div>
  );
}

function PriceCard({ card, billing, showResult, membershipHref }: {
  card: LandingCard; billing: PaywallBilling; showResult: boolean; membershipHref: string;
}) {
  const quote = card.quotes[billing];
  const ready = card.checkoutReady[billing];
  return (
    <section data-testid={`landing-plan-${card.key}`} aria-label={card.name} className={styles.card} data-recommended={card.recommended}>
      <div className={styles.cardHead}>
        <p className={styles.cardName}>{card.name}</p>
        {card.recommended ? <span className={styles.recTag}>推荐</span> : null}
      </div>
      {showResult ? <p className={styles.result}>{card.result.text}</p> : null}
      {quote ? (
        <div>
          {quote.tag ? <span className={styles.badge}>{quote.tag}</span> : null}
          <p className={styles.priceLine}>
            {quote.strike ? <s>{quote.strike}</s> : null}
            <CountUp key={billing} text={quote.price} />
            <span className={styles.per}>{quote.per}</span>
          </p>
          {quote.saving ? <p className={styles.saving}>{quote.saving}</p> : null}
        </div>
      ) : <p className={styles.muted}>{card.missingNote[billing] ?? '暂不提供'}</p>}
      {quote ? (
        <div>
          <Link href={ready ? membershipHref : '/contact'}
            className={cn(card.recommended ? styles.pillLight : styles.pill, styles.cardCta)}>
            {ready ? card.cta : '联系我们'}
          </Link>
          <p data-testid={`landing-renewal-${card.key}`} className={styles.renewal}>{quote.renewal}</p>
        </div>
      ) : null}
      <p className={styles.fit}>适合：{card.fit}</p>
    </section>
  );
}
