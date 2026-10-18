/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState, type CSSProperties } from 'react';
import Link from 'next/link';
import type { PaywallBilling } from '@/components/paywall/paywallPlans';
import { depthClass, DigitRoll } from '@/components/public-site/motion/depth-text';
import type { LandingCard } from '@/lib/landing/landing-pricing';
import { cn } from '@/lib/utils';
import styles from './h.module.css';

/** The monthly / yearly switch and the plan cards. Every number is built on the server (landing-pricing.ts). */
export function PlanCardsH({ cards, yearlyBadge, showResult, membershipHref }: {
  cards: readonly LandingCard[];
  yearlyBadge: string | null;
  showResult: Record<string, boolean>;
  membershipHref: string;
}) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  const hasYearly = cards.some(card => card.quotes.yearly);
  return (
    <div className={styles.plans} data-region="会员方案">
      <div role="radiogroup" aria-label="计费周期" className={cn(styles.billing, styles.glass)} data-cycle={billing}>
        <span className={styles.billingThumb} aria-hidden="true" />
        {(['monthly', 'yearly'] as const).map(cycle => {
          const disabled = cycle === 'yearly' && !hasYearly;
          return (
            <label key={cycle} data-on={billing === cycle} data-disabled={disabled}>
              <input type="radio" name="preview-h-billing" className="sr-only" value={cycle} checked={billing === cycle}
                disabled={disabled} onChange={() => setBilling(cycle)} />
              {cycle === 'monthly' ? '月付' : '年付'}
              {cycle === 'yearly' && yearlyBadge ? <span className={styles.saveTag}>{yearlyBadge}</span> : null}
            </label>
          );
        })}
      </div>
      <div className={styles.board}>
        {cards.map((card, index) => {
          const quote = card.quotes[billing];
          const ready = card.checkoutReady[billing];
          return (
            <div key={card.key} className={cn(styles.planSlot, depthClass.depthSide)} style={{ '--side': index % 2 ? -1 : 1 } as CSSProperties}>
              <section data-testid={`landing-plan-${card.key}`} aria-label={card.name} data-tilt=""
                className={cn(styles.plan, depthClass.tilt, depthClass.sheen)} data-recommended={card.recommended}>
                {card.recommended ? <span className={styles.planEdge} aria-hidden="true"><i /></span> : null}
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
                      <DigitRoll value={quote.price} className={styles.planFigure} />
                      <span>{quote.per}</span>
                    </p>
                    {quote.saving ? <p className={styles.planSaving}>{quote.saving}</p> : null}
                  </div>
                ) : <p className={styles.planMissing}>{card.missingNote[billing] ?? '暂不提供'}</p>}
                {quote ? (
                  <div className={styles.planAction}>
                    <Link href={ready ? membershipHref : '/contact'} className={cn(styles.pill, styles.pillInk)}>
                      {ready ? card.cta : '联系我们'}
                    </Link>
                    <p data-testid={`landing-renewal-${card.key}`}>{quote.renewal}</p>
                  </div>
                ) : null}
                <p className={styles.planFit}>适合：{card.fit}</p>
              </section>
            </div>
          );
        })}
      </div>
    </div>
  );
}
