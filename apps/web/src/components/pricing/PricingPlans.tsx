/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PaywallCompareTable } from '@/components/paywall/PaywallPlanPicker';
import {
  PLAN_FIT, formatUsd, monthlyCredits, paywallQuote, pickPaywallPlans, yearlyBadge,
  type PaywallBilling, type PaywallPlan, type PaywallPlanSource,
} from '@/components/paywall/paywallPlans';
import { PRICING_COPY as COPY } from './pricingContent';

const LABEL = { pro: 'Pro', gold: 'Gold' } as const;
const card = { background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' };

/** Sign-up and membership links, built by the server page so server and client HTML match. */
export type PricingLinks = { signup: string; membership: string };

/** Free / Pro / Gold with a monthly-yearly switch; monthly is the default (MASTER_PLAN §2.1 item 51). */
export function PricingPlans({ plans: source, links }: { plans: readonly PaywallPlanSource[]; links: PricingLinks }) {
  const plans = pickPaywallPlans(source);
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  const badge = yearlyBadge(plans);
  const yearly = plans.some(plan => paywallQuote(plan, 'yearly'));
  if (plans.length === 0) {
    return <p role="status" className="text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>{COPY.catalogUnavailable}</p>;
  }
  return (
    <div className="grid gap-8">
      <div role="radiogroup" aria-label="计费周期" className="mx-auto grid w-full max-w-xs grid-cols-2 gap-1 rounded-lg p-1"
        style={{ background: 'var(--bg-tertiary)' }}>
        {(['monthly', 'yearly'] as const).map(cycle => (
          <label key={cycle} className={cn('flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-2',
            'text-sm font-medium', cycle === 'yearly' && !yearly && 'cursor-not-allowed opacity-50')}
            style={billing === cycle ? { background: 'var(--bg-secondary)', color: 'var(--text-primary)' }
              : { color: 'var(--text-secondary)' }}>
            <input type="radio" name="pricing-billing" className="sr-only" value={cycle} checked={billing === cycle}
              disabled={cycle === 'yearly' && !yearly} onChange={() => setBilling(cycle)} />
            {cycle === 'monthly' ? '月付' : '年付'}
            {cycle === 'yearly' && badge ? <span className="rounded-full px-1.5 py-0.5 text-xs"
              style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>{badge}</span> : null}
          </label>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <section data-testid="pricing-plan-free" className="grid content-start gap-3 rounded-2xl border p-5" style={card}>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{COPY.freeName}</h2>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{COPY.freeFit}</p>
          <p><b className="text-3xl" style={{ color: 'var(--text-primary)' }}>$0</b></p>
          <PointList points={COPY.freePoints} />
          <Link className="mt-2 rounded-lg border px-4 py-2 text-center text-sm font-medium" style={{ borderColor: 'var(--border-primary)',
            color: 'var(--text-primary)' }} href={links.signup}>{COPY.freeCta}</Link>
        </section>
        {plans.map(plan => <PaidPlanCard key={plan.id} plan={plan} billing={billing} membershipHref={links.membership} />)}
      </div>

      <div className="rounded-2xl border p-4" style={card}>
        <PaywallCompareTable plans={plans} />
      </div>
    </div>
  );
}

function PaidPlanCard({ plan, billing, membershipHref }: { plan: PaywallPlan; billing: PaywallBilling; membershipHref: string }) {
  const quote = paywallQuote(plan, billing);
  const ready = quote?.checkoutReady === true;
  return (
    <section data-testid={`pricing-plan-${plan.level}`} className="grid content-start gap-3 rounded-2xl border p-5"
      style={{ ...card, borderColor: plan.level === 'gold' ? 'var(--warning)' : card.borderColor }}>
      <h2 className="flex items-center gap-2 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
        {LABEL[plan.level]}
        {plan.level === 'gold' ? <span className="rounded-full px-2 py-0.5 text-xs font-medium"
          style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>功能最全</span> : null}
      </h2>
      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{PLAN_FIT[plan.level]}</p>
      {quote ? (
        <div className="grid gap-0.5">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <b className="text-3xl" style={{ color: 'var(--text-primary)' }}>{formatUsd(quote.amount)}</b>
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{quote.perLabel}</span>
          </p>
          {quote.monthlyEquivalent ? <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{quote.monthlyEquivalent}</span> : null}
          {quote.saving ? <span className="text-sm" style={{ color: 'var(--success)' }}>{quote.saving}</span> : null}
        </div>
      ) : <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>暂不提供年付</p>}
      <PointList points={[`每月 ${monthlyCredits(plan).toLocaleString('en-US')} 积分`, '可以生成完整运营策略报告', '可以购买积分包，享会员折扣']} />
      {quote ? <p data-testid={`pricing-renewal-${plan.level}`} className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {quote.renewal}</p> : null}
      {ready ? (
        <Link className="mt-1 rounded-lg px-4 py-2 text-center text-sm font-semibold"
          style={{ background: 'var(--text-primary)', color: 'var(--bg-primary)' }}
          href={membershipHref}>{COPY.memberCta}</Link>
      ) : (
        <Link className="mt-1 rounded-lg border px-4 py-2 text-center text-sm font-medium"
          style={{ borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }} href="/contact">{COPY.contactCta}</Link>
      )}
      {ready ? <small className="text-center text-xs" style={{ color: 'var(--text-tertiary)' }}>{COPY.memberCtaNote}</small> : null}
    </section>
  );
}

function PointList({ points }: { points: readonly string[] }) {
  return (
    <ul className="grid gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
      {points.map(point => (
        <li key={point} className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" style={{ color: 'var(--success)' }} />{point}
        </li>
      ))}
    </ul>
  );
}
