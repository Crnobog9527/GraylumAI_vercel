/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { PaywallBilling } from '@/components/paywall/paywallPlans';
import type { LandingCard } from '@/lib/landing/landing-pricing';
import { cn } from '@/lib/utils';
import styles from './i.module.css';

/** Sample I's monthly / yearly switch and plan cards (logic as sample G's). Every number is built on the server (landing-pricing.ts). */
export function PlanCards({ cards, yearlyBadge, showResult, membershipHref }: {
  cards: readonly LandingCard[];
  yearlyBadge: string | null;
  showResult: Record<string, boolean>;
  membershipHref: string;
}) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  const hasYearly = cards.some(card => card.quotes.yearly);
  return (
    <div className={styles.plans}>
      <div role="radiogroup" aria-label="计费周期" className={styles.billing}>
        {(['monthly', 'yearly'] as const).map(cycle => {
          const disabled = cycle === 'yearly' && !hasYearly;
          return (
            <label key={cycle} data-on={billing === cycle} data-disabled={disabled}>
              <input type="radio" name="preview-i-billing" className="sr-only" value={cycle} checked={billing === cycle}
                disabled={disabled} onChange={() => setBilling(cycle)} />
              {cycle === 'monthly' ? '月付' : '年付'}
              {cycle === 'yearly' && yearlyBadge ? <span className={styles.saveTag}>{yearlyBadge}</span> : null}
            </label>
          );
        })}
      </div>
      <div className={styles.board}>
        {cards.map(card => {
          const quote = card.quotes[billing];
          const ready = card.checkoutReady[billing];
          return (
            <section key={card.key} data-testid={`landing-plan-${card.key}`} aria-label={card.name}
              className={cn(styles.plan, styles.sticker)} data-recommended={card.recommended}>
              <div className={styles.planHead}>
                <p className={styles.planName}>{card.name}</p>
                {card.recommended ? <span className={styles.planTag}>推荐</span> : null}
              </div>
              {showResult[card.key] ? <p className={styles.planResult}>{card.result.text}</p> : null}
              {quote ? (
                <div className={styles.planPrice}>
                  {quote.tag ? <span className={styles.saveTag}>{quote.tag}</span> : null}
                  <p>
                    {quote.strike ? <s>{quote.strike}</s> : null}
                    <span className={styles.planFigure}>{quote.price}</span>
                    <span>{quote.per}</span>
                  </p>
                  {quote.saving ? <p className={styles.planSaving}>{quote.saving}</p> : null}
                </div>
              ) : <p className={styles.planMissing}>{card.missingNote[billing] ?? '暂不提供'}</p>}
              {quote ? (
                <div className={styles.planAction}>
                  <Link href={ready ? membershipHref : '/contact'} className={cn(styles.btn, styles.btnInk)}>
                    {ready ? card.cta : '联系我们'}
                  </Link>
                  <p data-testid={`landing-renewal-${card.key}`}>{quote.renewal}</p>
                </div>
              ) : null}
              <p className={styles.planFit}>适合：{card.fit}</p>
            </section>
          );
        })}
      </div>
    </div>
  );
}
