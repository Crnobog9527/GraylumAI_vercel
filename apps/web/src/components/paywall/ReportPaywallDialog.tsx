/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PaywallCompareTable, PaywallPlanPicker } from './PaywallPlanPicker';
import { MethodCheckoutForm } from './MethodCheckoutForm';
import { CHECKOUT_COPY, GOLD_FOUNDER_YEAR_USD } from './methodCheckout';
import { formatUsd, paywallQuote, type PaywallBilling, type PaywallLevel } from './paywallPlans';
import { usePaywallCheckout } from './usePaywallCheckout';
import { REPORT_DELIVERABLES, REPORT_PAYWALL_COPY as COPY } from './reportPaywallCopy';

/**
 * Scene 1 of the paywall design v25: a free user who confirmed every step asks for the report.
 * Left: what the report gives (nothing already confirmed is lost). Right: plans from the server
 * and the card checkout (`payments.methodCheckout`). No credit-cost estimate, no model names, no consent switch the
 * backend lacks (design README "文案规则").
 */
export function ReportPaywallDialog({ onClose }: { onClose: () => void }) {
  return <ReportPaywallView checkout={usePaywallCheckout()} onClose={onClose} />;
}

export type PaywallCheckout = ReturnType<typeof usePaywallCheckout>;

/** The paywall itself, given the plans and purchase action; kept apart so it renders without a server. */
export function ReportPaywallView({ checkout, onClose }: { checkout: PaywallCheckout; onClose: () => void }) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  const [selected, setSelected] = useState<PaywallLevel>('pro');
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { dialog.current?.focus(); }, []);

  const plan = checkout.plans.find(item => item.level === selected) ?? checkout.plans[0];
  const quote = plan ? paywallQuote(plan, billing, checkout.quoteOptions) : null;
  const purchase = plan && quote ? checkout.purchaseFor(plan, billing) : null;
  const lowest = checkout.plans.length ? Math.min(...checkout.plans.map(item => item.price.monthly)) : null;

  function chooseBilling(next: PaywallBilling) {
    setBilling(next);
    // Keep a plan that has a price for the chosen cycle selected.
    if (plan && !paywallQuote(plan, next, checkout.quoteOptions)) {
      const other = checkout.plans.find(item => paywallQuote(item, next, checkout.quoteOptions));
      if (other) setSelected(other.level);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="report-paywall-title" tabIndex={-1}
        data-testid="report-paywall" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
        className="relative grid max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-2xl border md:grid-cols-[1fr_1.15fr]"
        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }}>
        <Button variant="ghost" size="icon" aria-label="关闭" className="absolute right-2 top-2 z-10" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>

        <aside aria-label="报告预览" className="grid content-start gap-4 p-5 md:p-6" style={{ background: 'var(--bg-secondary)' }}>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{COPY.eyebrow}</p>
          <h3 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{COPY.dossierTitle}</h3>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{COPY.dossierLede}</p>
          <div className="grid gap-2">
            <b className="text-sm" style={{ color: 'var(--text-primary)' }}>{COPY.deliverHeading}</b>
            <ol className="grid gap-3">
              {REPORT_DELIVERABLES.map(([title, detail, why], index) => (
                <li key={title} className="grid grid-cols-[1.5rem_1fr] gap-2 text-sm">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>{index + 1}</span>
                  <span className="grid gap-0.5">
                    <b style={{ color: 'var(--text-primary)' }}>{title}</b>
                    <small style={{ color: 'var(--text-tertiary)' }}>{detail}</small>
                    <span style={{ color: 'var(--text-secondary)' }}>{why}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </aside>

        <section className="grid content-start gap-4 p-5 md:p-6">
          <div className="grid gap-1 pr-8">
            <h2 id="report-paywall-title" className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{COPY.title}</h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{COPY.lede}</p>
          </div>
          <div className="grid gap-2 rounded-xl border p-3 text-sm sm:grid-cols-2"
            style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
            <div className="grid"><span>{COPY.anchorConsultant}</span><b style={{ color: 'var(--text-primary)' }}>{COPY.anchorConsultantPrice}</b></div>
            {lowest ? <div className="grid"><span>{COPY.anchorGraylum}</span>
              <b style={{ color: 'var(--text-primary)' }}>{formatUsd(lowest)} / 月起</b></div> : null}
            <small className="sm:col-span-2" style={{ color: 'var(--text-tertiary)' }}>
              来源：<a className="underline" href={COPY.anchorSourceUrl} target="_blank" rel="noopener noreferrer">HawkSEM</a>
              （2026-07-27）：{COPY.anchorSourceQuote}
            </small>
          </div>

          {checkout.loading ? <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>正在读取会员方案…</p>
            : checkout.catalogFailed ? <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>{COPY.catalogFailed}</p>
              : (
                <>
                  <PaywallPlanPicker plans={checkout.plans} billing={billing} selected={plan?.level ?? 'pro'}
                    quoteOptions={checkout.quoteOptions} disabled={checkout.method.pending}
                    onBilling={chooseBilling} onSelect={setSelected} />
                  {checkout.founderSeats > 0 && plan?.level === 'gold' ? (
                    <p data-testid="paywall-founder-seats" className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      <b style={{ color: 'var(--text-primary)' }}>Gold 创始会员 · 年付 {formatUsd(GOLD_FOUNDER_YEAR_USD)}</b>
                      {' '}还剩 {checkout.founderSeats} 个名额（共 50 个），满了就关闭
                    </p>
                  ) : null}
                  <PaywallCompareTable plans={checkout.plans} />
                </>
              )}

          {plan && quote && !checkout.loading && !checkout.catalogFailed ? (
            <MethodCheckoutForm checkout={checkout.method} purchase={purchase} testIdPrefix="report-paywall"
              price={`${formatUsd(quote.amount)} ${quote.perLabel}`} renewal={quote.renewal}
              cta={`${COPY.cta} · ${formatUsd(quote.amount)}`} ctaSub={COPY.ctaSub}
              blockedReason={purchase ? null : COPY.notReady} onGoldFirstDeclined={checkout.declineFirstMonth}
              onFounderDeclined={checkout.declineFounder} onFounderSoldOut={checkout.markFounderSoldOut}
              fineprint={quote.founder ? CHECKOUT_COPY.founderRule : null}
              notice={checkout.founderSoldOut && plan.level === 'gold' && billing === 'yearly' ? CHECKOUT_COPY.founderSoldOut : null} />
          ) : null}

          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {COPY.trust.map(item => (
              <li key={item} className="flex items-center gap-1"><Check className="h-3.5 w-3.5" aria-hidden="true" />{item}</li>
            ))}
          </ul>
          <div className="grid justify-items-center gap-1 text-center">
            <Button variant="ghost" onClick={onClose}>{COPY.later}</Button>
            <small style={{ color: 'var(--text-tertiary)' }}>{COPY.laterNote}</small>
          </div>
        </section>
      </div>
    </div>
  );
}
