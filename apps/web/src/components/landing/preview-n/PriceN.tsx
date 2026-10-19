/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { CountUpJ } from '@/components/landing/preview-j/CountUpJ';
import { PRICE_TIMING, PRICING_PAGE } from '@/components/landing/preview-j/PriceJ';
import page from '@/components/landing/preview-j/j.module.css';
import { PlanCardsMNO } from '@/components/landing/preview-mno/PlanCardsMNO';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { PRICE_COMPARE, type CompareRow, type GatedText } from '@/lib/landing/landing-copy';
import { J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import type { LandingPricing } from '@/lib/landing/landing-pricing';
import { cn } from '@/lib/utils';
import styles from './n.module.css';

/**
 * Price as cells (direction E), sample L's content: the usual ways' costs, each with its source, in one cell (the
 * figures add up from zero once it is on screen, as in sample J); beside it the usual ways' total shown whole and
 * "Graylum AI：$29/月起" with the way to the full pricing page, the terms and the jury's line. Under them the shared
 * plan cards (Gold recommended, the frame's resting place) with "先聊后买" right under the cards and their buttons.
 * Every price comes from the server catalog. Both share one zone, so the frame rests on Gold over the whole price.
 */
export function PriceN({ pricing, rows, risk, showResult, membershipHref, after }: {
  pricing: LandingPricing;
  rows: readonly CompareRow[];
  risk: readonly GatedText[];
  showResult: Record<string, boolean>;
  membershipHref: string;
  after: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setSeen(true); observer.disconnect(); }
    }, { threshold: 0.3 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const allRows = J_PRICE_TOTAL.rows.every(id => rows.some(row => row.sourceId === id));
  return (
    <div data-zone="price">
      <section id="pricing" aria-labelledby="pricing-title" className={styles.section} data-region="价格">
        <div className={styles.wrap}>
          <div className={styles.head}><h2 id="pricing-title" className={styles.h2}>{J_PRICE.title}</h2></div>
          <div className={cn(styles.grid, styles.priceGrid)}>
            {rows.length > 0 ? (
              <div ref={ref} className={cn(styles.cell, styles.costCell)} data-cell="" data-region="费用对比表">
                <h3>{J_PRICE.compareTitle}</h3>
                <ul>
                  {rows.map((row, index) => (
                    <li key={row.sourceId}>
                      <span>{row.label}</span>
                      <b><CountUpJ text={row.price} play={seen} delay={index * PRICE_TIMING.row} /></b>
                      <small>{J_PRICE.sourceLabel}：{PRICE_COMPARE.sources[row.sourceId]}</small>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className={cn(styles.cell, styles.ownCell)} data-cell="" data-region="Graylum 价格">
              {allRows && rows.length > 0 ? (
                <p className={styles.total}>
                  <span>{J_PRICE_TOTAL.label}</span>
                  <b><CountUpJ text={J_PRICE_TOTAL.text} play={seen} duration={PRICE_TIMING.count} /></b>
                </p>
              ) : null}
              {pricing.proMonthly !== null ? (
                <>
                  <p className={styles.own}>{J_PRICE.ownPrice(formatUsd(pricing.proMonthly))}</p>
                  <Link href={PRICING_PAGE} className={page.pill}>{J_PRICE.more}<ArrowRight size={18} aria-hidden="true" /></Link>
                  {after}
                </>
              ) : null}
            </div>
          </div>
        </div>
      </section>
      <section aria-label="会员方案" className={styles.plansSection}>
        <div className={cn(styles.wrap, styles.plans)}>
          <PlanCardsMNO cards={pricing.cards} yearlyBadge={pricing.yearlyBadge} showResult={showResult}
            membershipHref={membershipHref} risk={risk} />
        </div>
      </section>
    </div>
  );
}
