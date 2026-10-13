/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { FINAL_ACTION, PRICE_COMPARE, RISK_REVERSAL, type CompareRow, type GatedText } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE, type LandingFaqGroup } from '@/lib/landing/landing-faq';
import type { LandingPricing } from '@/lib/landing/landing-pricing';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { EPriceCards } from './EPriceCards';
import styles from './e.module.css';

/** Module 4: what the same work costs elsewhere, the cards, then "先聊后买" and the sources. */
export function EPrice({ pricing, rows, risk, showResult, founderSeats, membershipHref }: {
  pricing: LandingPricing;
  rows: readonly CompareRow[];
  risk: readonly GatedText[];
  showResult: Record<string, boolean>;
  founderSeats: number | null;
  membershipHref: string;
}) {
  return (
    <section id="pricing" aria-labelledby="e-pricing-title" className={cn(styles.section, styles.anchor)}>
      <div className={styles.wrap}>
        <div className={styles.headRow}>
          <h2 id="e-pricing-title" className={styles.display}>{PRICE_COMPARE.title}</h2>
        </div>
        {rows.length > 0 ? (
          <div className={styles.compare}>
            <p className={styles.compareLede}>{PRICE_COMPARE.lede}</p>
            {rows.map((row, index) => (
              <div key={row.sourceId} className={styles.compareRow}>
                <span>{row.label}<sup>{index + 1}</sup></span>
                <span>{row.price}</span>
              </div>
            ))}
            {pricing.proMonthly !== null ? <p className={styles.own}>{PRICE_COMPARE.ownPrice(formatUsd(pricing.proMonthly))}</p> : null}
          </div>
        ) : null}
        {pricing.founderOpen ? (
          <p className={styles.founder}>
            前 50 位创始会员，招满为止{founderSeats !== null ? <span>还剩 {founderSeats} 个名额</span> : null}
          </p>
        ) : null}
        {pricing.cards.length > 0 ? (
          <EPriceCards cards={pricing.cards} yearlyBadge={pricing.yearlyBadge} showResult={showResult} membershipHref={membershipHref} />
        ) : (
          <p role="status" className={styles.lede}>
            会员方案暂时读不到，请稍后刷新，或先看<Link href="/landing/pricing">价格页</Link>。
          </p>
        )}
        <div className={styles.risk}>
          <h3 className={styles.h3}>{RISK_REVERSAL.title}</h3>
          <ul>{risk.map(point => <li key={point.text}>{point.text}</li>)}</ul>
        </div>
        {rows.length > 0 ? (
          <div className={styles.sources}>
            <p>{PRICE_COMPARE.sourcesTitle}</p>
            <ol>{rows.map(row => <li key={row.sourceId}>{PRICE_COMPARE.sources[row.sourceId]}</li>)}</ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Module 5: FAQ with native <details> (no client JS); the heading stays put on wide screens. */
export function EFaq({ groups }: { groups: readonly LandingFaqGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section id="faq" aria-labelledby="e-faq-title" className={cn(styles.section, styles.anchor)}>
      <div className={cn(styles.wrap, styles.faqGrid)}>
        <div className={styles.faqHead}>
          <h2 id="e-faq-title" className={styles.display}>{LANDING_FAQ_TITLE}</h2>
        </div>
        <div>
          {groups.map(group => (
            <div key={group.title} className={styles.faqGroup}>
              <h3 className={styles.faqGroupTitle}>{group.title}</h3>
              {group.items.map(item => (
                <details key={item.id} id={item.id} className={styles.faqItem}>
                  <summary><span>{item.question}</span><Plus size={20} aria-hidden="true" /></summary>
                  <div className={styles.faqAnswer}>{item.answer.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
                </details>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Module 6: the two paths. The old one stays grey, the new one is in ink; then one button. */
export function EFinal({ showStack, founderSeats, note }: { showStack: boolean; founderSeats: number | null; note: string }) {
  return (
    <section aria-labelledby="e-final-title" className={cn(styles.section, styles.final)}>
      <div className={cn(styles.wrap, styles.narrow)}>
        <h2 id="e-final-title" className={styles.display}>{FINAL_ACTION.title}</h2>
        <ul className={styles.paths}>{FINAL_ACTION.paths.map(path => <li key={path}>{path}</li>)}</ul>
        {showStack ? <p className={styles.stack}><b>{FINAL_ACTION.stackLabel}</b>{FINAL_ACTION.stack.text}</p> : null}
        {founderSeats !== null ? (
          <p className={styles.finalFounder}>{FINAL_ACTION.founderLine}<span>还剩 {founderSeats} 个名额</span></p>
        ) : null}
        <div className={styles.finalCta}><Link href={SIGNUP_CTA_HREF} className={styles.pill}>{FINAL_ACTION.cta}</Link></div>
        <p className={styles.finalNote}>{note}</p>
      </div>
    </section>
  );
}
