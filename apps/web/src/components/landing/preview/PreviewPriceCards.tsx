/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { PaywallBilling } from '@/components/paywall/paywallPlans';
import type { LandingCard } from '@/lib/landing/landing-pricing';
import { cn } from '@/lib/utils';
import styles from './preview.module.css';

/** The same server-built cards and monthly/yearly switch as the landing page, in the light samples' style. */
export function PreviewPriceCards({ cards, yearlyBadge, showResult, membershipHref }: {
  cards: readonly LandingCard[];
  yearlyBadge: string | null;
  showResult: Record<string, boolean>;
  membershipHref: string;
}) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  const hasYearly = cards.some(card => card.quotes.yearly);
  return (
    <>
      <div role="radiogroup" aria-label="计费周期" className={styles.billing}>
        {(['monthly', 'yearly'] as const).map(cycle => {
          const disabled = cycle === 'yearly' && !hasYearly;
          return (
            <label key={cycle} data-on={billing === cycle} data-disabled={disabled}>
              <input type="radio" name="preview-billing" className="sr-only" value={cycle} checked={billing === cycle}
                disabled={disabled} onChange={() => setBilling(cycle)} />
              {cycle === 'monthly' ? '月付' : '年付'}
              {cycle === 'yearly' && yearlyBadge ? <span className={styles.saveTag}>{yearlyBadge}</span> : null}
            </label>
          );
        })}
      </div>
      <div className={styles.cards}>
        {cards.map(card => {
          const quote = card.quotes[billing];
          const ready = card.checkoutReady[billing];
          return (
            <section key={card.key} aria-label={card.name} className={styles.card} data-recommended={card.recommended}>
              <div className={styles.cardHead}>
                <p className={styles.cardName}>{card.name}</p>
                {card.recommended ? <span className={styles.tag}>推荐</span> : null}
              </div>
              {showResult[card.key] ? <p className={styles.result}>{card.result.text}</p> : null}
              {quote ? (
                <div>
                  {quote.tag ? <span className={styles.saveTag}>{quote.tag}</span> : null}
                  <p className={styles.priceLine}>
                    {quote.strike ? <s>{quote.strike}</s> : null}<b>{quote.price}</b><span className={styles.per}>{quote.per}</span>
                  </p>
                  {quote.saving ? <p className={styles.saving}>{quote.saving}</p> : null}
                </div>
              ) : <p className={styles.renewal}>{card.missingNote[billing] ?? '暂不提供'}</p>}
              {quote ? (
                <>
                  <Link href={ready ? membershipHref : '/contact'}
                    className={cn(card.recommended ? styles.primary : styles.secondary, styles.cardCta)}>
                    {ready ? card.cta : '联系我们'}
                  </Link>
                  <p className={styles.renewal}>{quote.renewal}</p>
                </>
              ) : null}
              <p className={styles.fit}>适合：{card.fit}</p>
            </section>
          );
        })}
      </div>
    </>
  );
}
