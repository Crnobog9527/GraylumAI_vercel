/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CHECKOUT_COPY, METHOD_COPY, TERMS_LINKS, refundPolicyHref, type CheckoutMethod, type MethodPurchase } from './methodCheckout';
import type { MethodCheckout } from './useMethodCheckout';

type Props = {
  checkout: MethodCheckout;
  /** null when the chosen item cannot be bought right now (the reason is `blockedReason`). */
  purchase: MethodPurchase | null;
  billingCycle?: MethodPurchase['billingCycle'];
  price: string;
  renewal: string;
  cta: string;
  ctaSub?: string;
  blockedReason?: string | null;
  /** Gold first month refused by the server: let the parent switch to the standard price. */
  onGoldFirstDeclined?: () => void;
  /** This account cannot take the founder price (an earlier founder order): let the parent switch to standard. */
  onFounderDeclined?: () => void;
  /** Founder seats sold out at checkout: the parent drops to the standard yearly price. */
  onFounderSoldOut?: () => void;
  /** A standing notice for this checkout (e.g. the founder price just sold out). */
  notice?: string | null;
  /** Extra rule shown under the renewal line (e.g. the founder renewal rule). */
  fineprint?: string | null;
  testIdPrefix: string;
};

const muted = { color: 'var(--text-tertiary)' };

/**
 * Payment method, tax note beside the price, the terms checkbox (MASTER_PLAN §2.1 item 51 record W:
 * unticked by default, no purchase without it) and the pay button. Shared by the report paywall,
 * the membership plans and the credit packs so every entry reads the same.
 */
export function MethodCheckoutForm(props: Props) {
  const { checkout, purchase, testIdPrefix: id } = props;
  const itemType = purchase?.itemType ?? 'membership_plan';
  const billingCycle = purchase?.billingCycle ?? props.billingCycle;
  const methods = checkout.methodsFor(itemType, billingCycle)
    .filter(method => purchase?.transition !== 'wallet_renewal' || method === 'wechat_pay' || method === 'alipay');
  const [picked, setPicked] = useState<CheckoutMethod>('card');
  // Consent is to one terms version: if methodMembership refetches a newer one (e.g. after reading the terms in
  // another tab), the box clears and must be ticked again for that version.
  const [acceptedVersion, setAcceptedVersion] = useState<string | null>(null);
  const termsVersion = checkout.entry?.termsVersion ?? null;
  const accepted = acceptedVersion !== null && acceptedVersion === termsVersion;
  const method = methods.includes(picked) ? picked : methods[0];
  const oneTimeWalletMembership = purchase?.itemType === 'membership_plan'
    && (method === 'wechat_pay' || method === 'alipay');
  const renewal = oneTimeWalletMembership && purchase?.offer !== 'founder_renewal'
    ? CHECKOUT_COPY.walletMembershipOneTime : props.renewal;
  const walletFounder = oneTimeWalletMembership && (purchase?.offer === 'founder' || purchase?.offer === 'founder_renewal');
  const fineprint = walletFounder ? CHECKOUT_COPY.walletFounderOneTime : props.fineprint;
  const purchaseKey = purchase ? JSON.stringify(purchase) : '';
  const { clearOutcome } = checkout;
  // A refusal belongs to the item it was about; choosing another item starts clean.
  useEffect(() => { clearOutcome(); }, [purchaseKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (checkout.loading) return <p className="text-sm" style={muted}>正在确认付款方式…</p>;
  if (checkout.failed) {
    return <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>暂时无法确认付款方式，请稍后再试。</p>;
  }
  if (!checkout.open || !method) {
    return <p role="status" data-testid={`${id}-closed`} className="text-sm" style={muted}>{CHECKOUT_COPY.closed}</p>;
  }

  const lockedMessage = checkout.lockedMessage(purchase);
  const outcome = checkout.outcome ?? (lockedMessage ? { tone: 'recovery' as const, message: lockedMessage,
    goldFirstIneligible: false, founderSoldOut: false, founderIneligible: false } : null);
  // After "recovery_required" (or an address we refused) the same order must not be bought again from here.
  const canPay = Boolean(purchase) && !props.blockedReason && accepted && !checkout.pending && outcome?.tone !== 'recovery' && !lockedMessage;
  return (
    <div className="grid gap-3" data-testid={`${id}-checkout`}>
      <fieldset className="grid gap-2" disabled={checkout.pending}>
        <legend className="mb-1 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>付款方式</legend>
        <div role="radiogroup" aria-label="付款方式" className="grid gap-2">
          {methods.map(item => (
            <label key={item} data-testid={`${id}-method-${item}`}
              className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: method === item ? 'var(--text-primary)' : 'var(--border-primary)' }}>
              <input type="radio" name={`${id}-method`} className="mt-1" value={item} checked={method === item}
                onChange={() => setPicked(item)} />
              <span className="grid min-w-0 gap-0.5">
                <b style={{ color: 'var(--text-primary)' }}>{METHOD_COPY[item].label}</b>
                {METHOD_COPY[item].note ? <span style={{ color: 'var(--warning)' }}>{METHOD_COPY[item].note}</span> : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <b className="text-base" style={{ color: 'var(--text-primary)' }}>{props.price}</b>
        <span data-testid={`${id}-tax`} style={{ color: 'var(--text-secondary)' }}>{METHOD_COPY[method].tax}</span>
      </p>
      <p className="text-xs" data-testid={`${id}-renewal`} style={muted}>{renewal}</p>
      {fineprint ? <p className="text-xs" data-testid={`${id}-fineprint`} style={muted}>{fineprint}</p> : null}
      <p className="text-xs" data-testid={`${id}-refund`} style={muted}>{CHECKOUT_COPY.refundSummary}</p>

      <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        <input type="checkbox" data-testid={`${id}-terms`} className="mt-1" checked={accepted}
          disabled={checkout.pending} onChange={event => setAcceptedVersion(event.target.checked ? termsVersion : null)} />
        <span>
          我已阅读并同意
          <a className="underline" href={TERMS_LINKS.terms} target="_blank" rel="noopener noreferrer">《服务条款》</a>和
          <a className="underline"
            data-testid={`${id}-refund-link`} href={refundPolicyHref(checkout.entry) ?? undefined} target="_blank" rel="noopener noreferrer">《退款政策》</a>
        </span>
      </label>

      <Button data-testid={`${id}-pay`} size="lg" className="h-auto flex-col gap-0.5 whitespace-normal py-3" disabled={!canPay}
        onClick={() => { if (purchase && canPay) void checkout.start(purchase, method, acceptedVersion, props.onFounderSoldOut); }}>
        <b>{checkout.pending ? '正在打开付款页面…' : props.cta}</b>
        {props.ctaSub ? <span className="text-xs font-normal opacity-80">{props.ctaSub}</span> : null}
      </Button>
      {!accepted && purchase && !props.blockedReason ? <p className="text-xs" style={muted}>{CHECKOUT_COPY.termsRequired}</p> : null}
      {props.notice ? <p role="status" data-testid={`${id}-notice`} className="text-sm" style={{ color: 'var(--warning)' }}>
        {props.notice}</p> : null}
      {props.blockedReason ? <p role="status" className="text-sm" style={{ color: 'var(--warning)' }}>{props.blockedReason}</p> : null}
      {outcome ? (
        <div role={outcome.tone === 'error' ? 'alert' : 'status'} data-testid={`${id}-outcome`} className="grid gap-2 text-sm"
          style={{ color: outcome.tone === 'error' ? 'var(--error)' : 'var(--warning)' }}>
          <p>{outcome.message}</p>
          {(outcome.goldFirstIneligible && props.onGoldFirstDeclined) || (outcome.founderIneligible && props.onFounderDeclined) ? (
            <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => {
              clearOutcome();
              (outcome.goldFirstIneligible ? props.onGoldFirstDeclined : props.onFounderDeclined)?.();
            }}>改按标准价购买</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
