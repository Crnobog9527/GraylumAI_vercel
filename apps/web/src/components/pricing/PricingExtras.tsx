/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { formatUsd, packDiscountLabel, pickPaywallPlans, type PaywallPlanSource } from '@/components/paywall/paywallPlans';
import { PRICING_COPY as COPY, pricingFaqItems } from './pricingContent';

export type PublicCreditPackage = { id: string; name?: string | null; credits: number; bonus_credits: number; price: number };

const card = { background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' };
const LABEL = { pro: 'Pro', gold: 'Gold' } as const;

/** Credit packs as the public catalog lists them; members only, so no buy button here. */
export function PricingCreditPacks({ packages, plans, failed }: {
  packages: readonly PublicCreditPackage[]; plans: readonly PaywallPlanSource[]; failed: boolean;
}) {
  const priced = packages.filter(pkg => Number.isFinite(pkg.price) && pkg.price > 0 && pkg.credits > 0);
  const discounts = pickPaywallPlans(plans).map(plan => `${LABEL[plan.level]} ${packDiscountLabel(plan.discount)}`);
  return (
    <section data-testid="pricing-credit-packs" className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{COPY.packsTitle}</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{COPY.packsLede}</p>
        {discounts.length ? <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {COPY.packsMemberDiscount}：{discounts.join(' · ')}</p> : null}
      </div>
      {failed || priced.length === 0 ? (
        <p role="status" className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{COPY.packsUnavailable}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          {priced.map(pkg => (
            <div key={pkg.id} className="grid gap-1 rounded-xl border p-4 text-center" style={card}>
              <b className="text-2xl" style={{ color: 'var(--text-primary)' }}>
                {(pkg.credits + Math.max(0, pkg.bonus_credits)).toLocaleString('en-US')} 积分</b>
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{formatUsd(pkg.price)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Studio: intent only, no team features promised until they exist (design README conflict 6). */
export function PricingStudio() {
  return (
    <section data-testid="pricing-studio" className="grid gap-3 rounded-2xl border p-5 md:grid-cols-[1fr_auto] md:items-center"
      style={card}>
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{COPY.studioTitle}</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{COPY.studioLede}</p>
      </div>
      <Link href="/contact" className="rounded-lg border px-4 py-2 text-center text-sm font-medium"
        style={{ borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>{COPY.contactCta}</Link>
    </section>
  );
}

export function PricingFaq() {
  return (
    <section data-testid="pricing-faq" className="grid gap-3">
      <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{COPY.faqTitle}</h2>
      {pricingFaqItems.map(item => (
        <details key={item.question} className="rounded-xl border p-4" style={card}>
          <summary className="cursor-pointer font-medium" style={{ color: 'var(--text-primary)' }}>{item.question}</summary>
          <p className="mt-3 text-sm leading-7" style={{ color: 'var(--text-secondary)' }}>{item.answer}</p>
        </details>
      ))}
    </section>
  );
}
