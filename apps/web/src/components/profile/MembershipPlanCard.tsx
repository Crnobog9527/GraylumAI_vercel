/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { GOLD_FIRST_MONTH_USD, GOLD_FOUNDER_YEAR_USD } from '@/components/paywall/methodCheckout';
import type { PlanAction } from './methodPlanAction';

export interface PlanConfig {
  id: string;
  name: string;
  level: string;
  price: { monthly: number; yearly: number };
  features: string[];
  recommended?: boolean;
  highlight?: boolean;
}

const warm = {
  background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.12) 0%, rgba(249, 115, 22, 0.14) 100%)',
  border: '2px solid rgba(245, 158, 11, 0.45)',
  shadow: '0 0 30px rgba(249, 115, 22, 0.16)',
  text: 'linear-gradient(135deg, #FBBF24 0%, #FB923C 100%)',
};

function Amount({ value, highlight }: { value: string; highlight: boolean }) {
  return (
    <span className="text-3xl font-bold" style={{ WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
      background: highlight ? warm.text : 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)' }}>
      {value}
    </span>
  );
}

/** One plan on the membership page; the button opens the card checkout dialog (or is hidden while it is closed). */
export function MembershipPlanCard({ plan, billingCycle, action, taxNote, firstMonth, founderSeats, founderRenewal = false, onSelect }: {
  plan: PlanConfig;
  billingCycle: 'monthly' | 'yearly';
  /** null while card checkout is closed: no purchase entry is shown. */
  action: PlanAction | null;
  taxNote: string | null;
  firstMonth: boolean;
  /** Real founder seats left for this card (Gold yearly only), 0 when none. */
  founderSeats: number;
  /** Server-projected one-time wallet founder renewal; its displayed amount is the existing $496 price. */
  founderRenewal?: boolean;
  onSelect: () => void;
}) {
  const highlight = Boolean(plan.recommended || plan.highlight);
  const price = Number(billingCycle === 'monthly' ? plan.price.monthly : plan.price.yearly);
  return (
    <div data-testid={`profile-membership-plan-${plan.level}`} data-plan-id={plan.id} data-plan-level={plan.level}
      data-highlight-tone={highlight ? 'warm' : 'default'} className="relative rounded-xl p-5 transition-colors duration-200"
      style={{ background: highlight ? warm.background : 'var(--bg-primary)',
        border: highlight ? warm.border : '1px solid var(--border-primary)', boxShadow: highlight ? warm.shadow : 'none' }}>
      {plan.recommended && (
        <div data-testid={`profile-membership-plan-recommended-${plan.level}`}
          className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-medium"
          style={{ background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.24) 0%, rgba(249, 115, 22, 0.24) 100%)',
            color: '#FBBF24', border: '1px solid rgba(245, 158, 11, 0.4)' }}>
          推荐
        </div>
      )}
      <h4 data-testid="profile-membership-plan-name" className="mb-4 text-center font-semibold" style={{ color: 'var(--text-primary)' }}>
        {plan.name}
      </h4>

      <div className="mb-4 grid justify-items-center gap-1 text-center">
        {price === 0 ? (
          <span className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>免费</span>
        ) : billingCycle === 'yearly' && (founderSeats > 0 || founderRenewal) ? (
          <>
            <div className="flex items-baseline justify-center gap-1">
              <Amount value={formatUsd(GOLD_FOUNDER_YEAR_USD)} highlight={highlight} />
              <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>/年</span>
            </div>
            <span data-testid={founderRenewal ? 'profile-founder-renewal-price' : 'profile-founder-seats'}
              className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {founderRenewal ? '创始会员续费价' : `创始会员 · 还剩 ${founderSeats} 个名额（共 50 个）`}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>标准年付 {formatUsd(price)}/年</span>
          </>
        ) : billingCycle === 'yearly' ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-sm line-through" style={{ color: 'var(--text-disabled)' }}>{formatUsd(plan.price.monthly)}/月</span>
              <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'rgba(34, 197, 94, 0.2)', color: 'var(--success)' }}>
                省{Math.round((1 - price / (plan.price.monthly * 12)) * 100)}%
              </span>
            </div>
            <div className="flex items-baseline justify-center gap-1">
              <Amount value={formatUsd(price)} highlight={highlight} />
              <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>/年</span>
            </div>
          </>
        ) : firstMonth ? (
          <>
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>首月</span>
              <Amount value={formatUsd(GOLD_FIRST_MONTH_USD)} highlight={highlight} />
            </div>
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>之后每月 {formatUsd(price)}</span>
          </>
        ) : (
          <div className="flex items-baseline justify-center gap-1">
            <Amount value={formatUsd(price)} highlight={highlight} />
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>/月</span>
          </div>
        )}
        {price > 0 && taxNote ? (
          <span data-testid={`profile-membership-plan-tax-${plan.level}`} className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {taxNote}
          </span>
        ) : null}
      </div>

      <div className="mb-5 space-y-2">
        {plan.features?.map((feature, idx) => (
          <div key={idx} className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--success)' }} />
            <span style={{ color: 'var(--text-secondary)' }}>{feature}</span>
          </div>
        ))}
      </div>

      {action ? (
        <Button onClick={onSelect} className="h-auto min-h-10 w-full whitespace-normal px-3 py-2 text-center" disabled={action.disabled}
          style={{ background: action.disabled ? 'var(--bg-tertiary)'
            : 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
          color: action.disabled ? 'var(--text-tertiary)' : 'var(--bg-primary)', cursor: action.disabled ? 'default' : 'pointer' }}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
