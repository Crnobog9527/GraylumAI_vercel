/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PLAN_EARLY_ACCESS, PLAN_FIT, PLAN_SUPPORT, formatUsd, monthlyCredits, packDiscountLabel, paywallQuote, yearlyBadge,
  type PaywallBilling, type PaywallLevel, type PaywallPlan,
} from './paywallPlans';

const LABEL: Record<PaywallLevel, string> = { pro: 'Pro', gold: 'Gold' };

type Props = {
  plans: PaywallPlan[];
  billing: PaywallBilling;
  selected: PaywallLevel;
  disabled: boolean;
  onBilling: (billing: PaywallBilling) => void;
  onSelect: (level: PaywallLevel) => void;
};

/** Billing switch and plan cards; monthly is the default (MASTER_PLAN §2.1 item 51). */
export function PaywallPlanPicker({ plans, billing, selected, disabled, onBilling, onSelect }: Props) {
  const badge = yearlyBadge(plans);
  const yearly = plans.some(plan => paywallQuote(plan, 'yearly'));
  return (
    <fieldset className="grid min-w-0 gap-3" disabled={disabled}>
      <legend className="sr-only">计费周期和方案</legend>
      <div role="radiogroup" aria-label="计费周期" className="grid grid-cols-2 gap-1 rounded-lg p-1"
        style={{ background: 'var(--bg-tertiary)' }}>
        {(['monthly', 'yearly'] as const).map(cycle => (
          <label key={cycle} className={cn('flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-2',
            'text-sm font-medium', cycle === 'yearly' && !yearly && 'cursor-not-allowed opacity-50')}
            style={billing === cycle ? { background: 'var(--bg-secondary)', color: 'var(--text-primary)' }
              : { color: 'var(--text-secondary)' }}>
            <input type="radio" name="paywall-billing" className="sr-only" value={cycle} checked={billing === cycle}
              disabled={cycle === 'yearly' && !yearly} onChange={() => onBilling(cycle)} />
            {cycle === 'monthly' ? '月付' : '年付'}
            {cycle === 'yearly' && badge ? (
              <span className="rounded-full px-1.5 py-0.5 text-xs" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
                {badge}
              </span>
            ) : null}
          </label>
        ))}
      </div>
      <div role="radiogroup" aria-label="会员方案" className={cn('grid gap-3', plans.length > 1 && 'sm:grid-cols-2')}>
        {plans.map(plan => {
          const quote = paywallQuote(plan, billing);
          const active = selected === plan.level;
          return (
            <label key={plan.id} data-testid={`paywall-plan-${plan.level}`}
              className={cn('grid cursor-pointer gap-1.5 rounded-xl border p-3 text-sm', !quote && 'cursor-not-allowed opacity-60')}
              style={{ background: 'var(--bg-secondary)', borderColor: active ? 'var(--text-primary)' : 'var(--border-primary)',
                boxShadow: active ? '0 0 0 1px var(--text-primary)' : undefined }}>
              <input type="radio" name="paywall-plan" className="sr-only" value={plan.level} checked={active}
                disabled={!quote} onChange={() => onSelect(plan.level)} />
              <span className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {LABEL[plan.level]}
                {plan.level === 'gold' ? <span className="rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>功能最全</span> : null}
              </span>
              <span style={{ color: 'var(--text-tertiary)' }}>{PLAN_FIT[plan.level]}</span>
              {quote ? (
                <>
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <b className="text-2xl" style={{ color: 'var(--text-primary)' }}>{formatUsd(quote.amount)}</b>
                    <span style={{ color: 'var(--text-tertiary)' }}>{quote.perLabel}</span>
                    {quote.saving ? <em className="not-italic" style={{ color: 'var(--success)' }}>{quote.saving}</em> : null}
                  </span>
                  {quote.monthlyEquivalent ? <span style={{ color: 'var(--text-tertiary)' }}>{quote.monthlyEquivalent}</span> : null}
                </>
              ) : <span style={{ color: 'var(--text-tertiary)' }}>暂不提供年付</span>}
              <span style={{ color: 'var(--text-secondary)' }}>每月 {monthlyCredits(plan).toLocaleString('en-US')} 积分</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Pro/Gold comparison; only rows the backend or an Owner decision backs (no unlaunched features). */
export function PaywallCompareTable({ plans }: { plans: PaywallPlan[] }) {
  if (plans.length < 2) return null;
  const yes = <Check className="inline h-4 w-4" aria-label="有" style={{ color: 'var(--success)' }} />;
  const no = <Minus className="inline h-4 w-4" aria-label="没有" style={{ color: 'var(--text-disabled)' }} />;
  const rows: Array<[string, (plan: PaywallPlan) => ReactNode]> = [
    ['每月积分', plan => monthlyCredits(plan).toLocaleString('en-US')],
    ['积分包', plan => packDiscountLabel(plan.discount)],
    ['客服回复', plan => PLAN_SUPPORT[plan.level]],
    ['优先体验内测新功能', plan => (PLAN_EARLY_ACCESS[plan.level] ? yes : no)],
  ];
  return (
    <table className="w-full text-left text-sm" data-testid="paywall-compare">
      <thead>
        <tr style={{ color: 'var(--text-tertiary)' }}>
          <th className="py-1.5 font-medium">Pro 和 Gold 对比</th>
          {plans.map(plan => <th key={plan.id} className="py-1.5 font-medium">{LABEL[plan.level]}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, cell]) => (
          <tr key={label} className="border-t" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
            <td className="py-1.5">{label}</td>
            {plans.map(plan => <td key={plan.id} className="py-1.5">{cell(plan)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
