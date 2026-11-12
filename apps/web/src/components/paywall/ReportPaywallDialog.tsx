/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PaywallCompareTable, PaywallPlanPicker } from './PaywallPlanPicker';
import { MethodCheckoutForm } from './MethodCheckoutForm';
import { CHECKOUT_COPY, GOLD_FOUNDER_YEAR_USD } from './methodCheckout';
import { SUPPORT_TICKET_HREF, UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE } from '@/components/profile/subscriptionPlanButtonState';
import { formatUsd, fusionPlanLevel, paywallQuote, type PaywallBilling, type PaywallLevel } from './paywallPlans';
import { usePaywallCheckout } from './usePaywallCheckout';
import { reportPaywallView } from '@/lib/analytics/events';
import { trpc } from '@/trpc/client';
import { profileTabHref } from '@/lib/profile-tabs';
import { REPORT_DELIVERABLES, REPORT_PAYWALL_COPY as REPORT_COPY } from './reportPaywallCopy';
import { GOLD_SCENE_DELIVERABLES, goldSceneCopy, upgradeTarget, type GoldScene } from './goldScenePaywallCopy';
import { COACH_SCENE_DELIVERABLES, coachSceneCopy } from './coachScenePaywallCopy';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { cn } from '@/lib/utils';
import { lightDialogStyle, lightOverlayClass, lightPortalClass } from '@/components/design/light-portal';

/**
 * Scene 1 of the paywall design v25: a free user who confirmed every step asks for the report.
 * Left: what the report gives (nothing already confirmed is lost). Right: plans from the server
 * and the card checkout (`payments.methodCheckout`). No credit-cost estimate, no model names, no consent switch the
 * backend lacks (design README "文案规则").
 */
export type PaywallScene = 'report' | 'coach' | GoldScene;

export function ReportPaywallDialog({ onClose, scene = 'report', minLevel = 'pro' }: { onClose: () => void; scene?: PaywallScene; minLevel?: 'pro' | 'gold' }) {
  // One paywall_view per display (GA4 only, consent-gated; the funnel continues with begin_checkout / purchase).
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    reportPaywallView(scene);
  }, [scene]);
  // A Gold-only scene is also opened by Pro members, whose purchase is an upgrade with the old subscription named; that flow
  // lives on the subscription page. Only a free account buys inline here.
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { enabled: scene !== 'report', staleTime: 30_000, retry: false });
  const memberLevel = scene === 'report' ? 'free' : entitlements.isError ? 'unknown' : entitlements.data ? (entitlements.data.level ?? 'free') : 'loading';
  return <ReportPaywallView checkout={usePaywallCheckout()} onClose={onClose} scene={scene} memberLevel={memberLevel} minLevel={minLevel} />;
}

export type PaywallCheckout = ReturnType<typeof usePaywallCheckout>;

/** The paywall itself, given the plans and purchase action; kept apart so it renders without a server. */
export function ReportPaywallView({ checkout: fullCheckout, onClose, scene = 'report', memberLevel = 'free', minLevel = 'pro' }: {
  checkout: PaywallCheckout; onClose: () => void; scene?: PaywallScene; memberLevel?: string; minLevel?: 'pro' | 'gold';
}) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  // A Gold-only feature offers only the Gold plans (Gold first month and the founder price still come from the server).
  // The coach scene sells Pro and Gold both (a member-only Skill for the two plans), so it is not Gold-only.
  // (A Skill that needs Gold sells only the Gold plans, like the Gold-only scenes, so nobody buys Pro for it.)
  const goldOnly = scene !== 'report' && (scene !== 'coach' || minLevel === 'gold');
  const inlinePurchase = !goldOnly || memberLevel === 'free';
  // The jury and the model comparison name and sell the plans whose own entitlement switch carries the tool (not a fixed "Gold");
  // while the catalog names no such plan, the words name none and the Gold plans are offered as before.
  const tool = scene === 'compare' || scene === 'jury' ? scene : null;
  const need = tool ? fusionPlanLevel(fullCheckout.plans, tool) : null;
  const carries = tool === 'jury' ? 'allowFusionReview' : 'allowFusionCompare';
  const checkout = goldOnly ? { ...fullCheckout, plans: fullCheckout.plans.filter(item => (tool && need ? item[carries] === true : item.level === 'gold')) }
    : fullCheckout;
  const COPY = scene === 'coach' ? { ...REPORT_COPY, ...coachSceneCopy(minLevel) } : tool ? { ...REPORT_COPY, ...goldSceneCopy(tool, need) } : REPORT_COPY;
  const target = tool ? upgradeTarget(need) : ' Gold';
  const deliverables = scene === 'coach' ? COACH_SCENE_DELIVERABLES : goldOnly ? GOLD_SCENE_DELIVERABLES[scene] : REPORT_DELIVERABLES;
  const [selected, setSelected] = useState<PaywallLevel>(goldOnly ? 'gold' : 'pro');
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
    // The light signed-in dialog (DESIGN.md "Dialog", the same tone as the checkout dialog): it carries its own tokens, so it is light
    // wherever it is opened. Touch widths get 44px targets.
    <div className={cn('fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4', lightOverlayClass)}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="report-paywall-title" tabIndex={-1}
        data-testid="report-paywall" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
        className={cn('relative grid max-h-[94dvh] w-full max-w-5xl overflow-y-auto border md:grid-cols-[1fr_1.15fr]', lightPortalClass)}
        style={lightDialogStyle}>
        <Button variant="ghost" size="icon" aria-label="关闭" className="absolute right-1 top-1 z-10 h-11 w-11 sm:right-2 sm:top-2 sm:h-9 sm:w-9"
          onClick={onClose}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>

        <aside aria-label={goldOnly ? '功能介绍' : '报告预览'} className="grid content-start gap-4 p-5 md:p-6" style={{ background: 'var(--bg-secondary)' }}>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{COPY.eyebrow}</p>
          <h3 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{COPY.dossierTitle}</h3>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{COPY.dossierLede}</p>
          <div className="grid gap-2">
            <b className="text-sm" style={{ color: 'var(--text-primary)' }}>{COPY.deliverHeading}</b>
            <ol className="grid gap-3">
              {deliverables.map(([title, detail, why], index) => (
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
          {goldOnly ? null : <div className="grid gap-2 rounded-xl border p-3 text-sm sm:grid-cols-2"
            style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
            <div className="grid"><span>{COPY.anchorConsultant}</span><b style={{ color: 'var(--text-primary)' }}>{COPY.anchorConsultantPrice}</b></div>
            {lowest ? <div className="grid"><span>{COPY.anchorGraylum}</span>
              <b style={{ color: 'var(--text-primary)' }}>{formatUsd(lowest)} / 月起</b></div> : null}
            <small className="sm:col-span-2" style={{ color: 'var(--text-tertiary)' }}>
              来源：<a className="underline" href={COPY.anchorSourceUrl} target="_blank" rel="noopener noreferrer">HawkSEM</a>
              （2026-07-27）：{COPY.anchorSourceQuote}
            </small>
          </div>}

          {!inlinePurchase ? (
            <div className="grid gap-2 rounded-xl border p-3 text-sm" data-testid="paywall-upgrade-via-subscription"
              style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
              {memberLevel === 'loading' ? <PageSkeleton compact rows={2} label="会员状态读取中"/> : <>
                <p>{memberLevel === 'pro' ? `你现在是 Pro 会员，升级到${target}在订阅页完成：原 Pro 到本期结束，已有积分保留。`
                  : `请到订阅页开通或升级到${target}。`}</p>
                <Button asChild className="h-11 sm:h-9"><a href={profileTabHref('subscription')} target="_blank" rel="noopener">去订阅页升级到{target}</a></Button>
              </>}
            </div>
          ) : checkout.loading ? <PageSkeleton compact rows={3} label="会员方案读取中"/>
            : checkout.catalogFailed ? <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>{COPY.catalogFailed}</p>
              : (
                <>
                  <PaywallPlanPicker plans={checkout.plans} billing={billing} selected={plan?.level ?? selected}
                    quoteOptions={checkout.quoteOptions} yearlyCheckoutAvailable={checkout.method.methodsFor('membership_plan', 'yearly').length > 0}
                    disabled={checkout.method.pending} oneTime={checkout.method.entry?.purchaseChannel === 'waffo'}
                    onBilling={chooseBilling} onSelect={setSelected} />
                  {checkout.founderSeats > 0 && plan?.level === 'gold' && billing === 'yearly' ? (
                    <p data-testid="paywall-founder-seats" className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      <b style={{ color: 'var(--text-primary)' }}>Gold 创始会员 · 年付 {formatUsd(GOLD_FOUNDER_YEAR_USD)}</b>
                      {' '}还剩 {checkout.founderSeats} 个名额（共 50 个），满了就关闭
                    </p>
                  ) : null}
                  <PaywallCompareTable plans={checkout.plans} />
                </>
              )}

          {inlinePurchase && plan && quote && !checkout.loading && !checkout.catalogFailed ? (
            <>
              <MethodCheckoutForm checkout={checkout.method} purchase={purchase} billingCycle={billing} testIdPrefix="report-paywall"
                price={`${formatUsd(quote.amount)} ${quote.perLabel}`} renewal={quote.renewal}
                cta={`${COPY.cta} · ${formatUsd(quote.amount)}`} ctaSub={COPY.ctaSub}
                blockedReason={checkout.unpaidSubscription ? UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE : purchase ? null : COPY.notReady}
                onGoldFirstDeclined={checkout.declineFirstMonth}
                onFounderDeclined={checkout.declineFounder} onFounderSoldOut={checkout.markFounderSoldOut}
                fineprint={quote.founder ? CHECKOUT_COPY.founderRule : null}
                notice={checkout.founderSoldOut && plan.level === 'gold' && billing === 'yearly' ? CHECKOUT_COPY.founderSoldOut : null} />
              {checkout.unpaidSubscription ? <a data-testid="report-paywall-support-ticket" href={SUPPORT_TICKET_HREF}
                className="inline-flex min-h-11 items-center text-sm underline sm:min-h-0" style={{ color: 'var(--text-primary)' }}>提交工单</a> : null}
            </>
          ) : null}

          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {(goldOnly ? COPY.trust.slice(0, 2) : COPY.trust).map(item => (
              <li key={item} className="flex items-center gap-1"><Check className="h-3.5 w-3.5" aria-hidden="true" />{item}</li>
            ))}
          </ul>
          <div className="grid justify-items-center gap-1 text-center">
            <Button variant="ghost" className="h-11 sm:h-9" onClick={onClose}>{COPY.later}</Button>
            <small style={{ color: 'var(--text-tertiary)' }}>{COPY.laterNote}</small>
          </div>
        </section>
      </div>
    </div>
  );
}
