/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import type { PaywallBilling } from '@/components/paywall/paywallPlans';
import { RISK_REVERSAL, type GatedText } from '@/lib/landing/landing-copy';
import type { LandingCard } from '@/lib/landing/landing-pricing';
import styles from './mno.module.css';

/**
 * Samples M, N and O's plan cards (the shared conversion rule, Owner 2026-10-17: the recommended plan, Gold, stands out
 * most, and "先聊后买" sits right under the cards and their buttons). Every name, price and line comes from the server
 * catalog (landing-pricing.ts) and the landing copy, as on /landing; nothing is written here. A variant restyles the
 * cards through its own root class (the elements carry data-plan and data-recommended).
 */
export function PlanCardsMNO({ cards, yearlyBadge, showResult, membershipHref, risk }: {
  cards: readonly LandingCard[];
  yearlyBadge: string | null;
  showResult: Record<string, boolean>;
  membershipHref: string;
  risk: readonly GatedText[];
}) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  const hasYearly = cards.some(card => card.quotes.yearly);
  if (cards.length === 0) return null;
  return (
    <div className={styles.plans} data-region="会员方案">
      <div role="radiogroup" aria-label="计费周期" className={styles.billing}>
        {(['monthly', 'yearly'] as const).map(cycle => {
          const disabled = cycle === 'yearly' && !hasYearly;
          return (
            <label key={cycle} data-on={billing === cycle || undefined} data-disabled={disabled || undefined}>
              <input type="radio" name="mno-billing" className="sr-only" value={cycle} checked={billing === cycle}
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
            <section key={card.key} data-testid={`landing-plan-${card.key}`} aria-label={card.name} className={styles.plan}
              data-plan={card.key} data-recommended={card.recommended || undefined}>
              <div className={styles.planHead}>
                <p className={styles.planName}>{card.name}</p>
                {card.recommended ? <span className={styles.planTag}>推荐</span> : null}
              </div>
              {showResult[card.key] ? <p className={styles.planResult}>{card.result.text}</p> : null}
              {quote ? (
                <div className={styles.planPrice}>
                  <p>
                    {quote.strike ? <s>{quote.strike}</s> : null}
                    <b>{quote.price}</b><span>{quote.per}</span>
                  </p>
                  {quote.tag ? <span className={styles.saveTag}>{quote.tag}</span> : null}
                  {quote.saving ? <p className={styles.planSaving}>{quote.saving}</p> : null}
                </div>
              ) : <p className={styles.planMissing}>{card.missingNote[billing] ?? '暂不提供'}</p>}
              {quote ? (
                <div className={styles.planAction}>
                  <Link href={ready ? membershipHref : '/contact'} className={styles.planButton}>{ready ? card.cta : '联系我们'}</Link>
                  <p data-testid={`landing-renewal-${card.key}`}>{quote.renewal}</p>
                </div>
              ) : null}
              <p className={styles.planFit}>适合：{card.fit}</p>
            </section>
          );
        })}
      </div>
      {risk.length > 0 ? (
        <div className={styles.risk} data-region="先聊后买">
          <p className={styles.riskTitle}><ShieldCheck size={18} aria-hidden="true" />{RISK_REVERSAL.title}</p>
          <ul>{risk.map(point => <li key={point.text}>{point.text}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}
