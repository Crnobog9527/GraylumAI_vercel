/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { PaywallBilling } from '@/components/paywall/paywallPlans';
import type { LandingCard } from '@/lib/landing/landing-pricing';
import { cn } from '@/lib/utils';
import { useFounderSeats } from './LiveFounderSeats';

/**
 * Monthly / yearly switch and the price cards in the paywall v25 format (monthly by default).
 * Cards and every number are built on the server (landing-pricing.ts); this only switches tabs.
 */
export function PriceCards({
  cards,
  yearlyBadge,
  yearlyBadgeWithoutFounder = yearlyBadge,
  showResult,
  membershipHref,
}: {
  cards: readonly LandingCard[];
  yearlyBadge: string | null;
  yearlyBadgeWithoutFounder?: string | null;
  // Result lines whose capability is on, by card key.
  showResult: Record<string, boolean>;
  membershipHref: string;
}) {
  const [billing, setBilling] = useState<PaywallBilling>('monthly');
  // The founder card leaves once the live seat count reaches 0 (LiveFounderSeats).
  const founderGone = useFounderSeats(null) === 0;
  const shown = founderGone ? cards.filter(card => card.key !== 'founder') : cards;
  const badge = founderGone ? yearlyBadgeWithoutFounder : yearlyBadge;
  const hasYearly = shown.some(card => card.quotes.yearly);

  return (
    <div className="grid gap-8">
      <div role="radiogroup" aria-label="计费周期"
        className="mx-auto grid w-full max-w-sm grid-cols-2 gap-1 rounded-xl border border-[#2A2A2A] bg-[#141414] p-1">
        {(['monthly', 'yearly'] as const).map(cycle => {
          const disabled = cycle === 'yearly' && !hasYearly;
          return (
            <label key={cycle} className={cn('flex cursor-pointer items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold',
              billing === cycle ? 'bg-[#FFD700] text-[#0A0A0A]' : 'text-[#B0B0B0]', disabled && 'cursor-not-allowed opacity-50')}>
              <input type="radio" name="landing-billing" className="sr-only" value={cycle} checked={billing === cycle}
                disabled={disabled} onChange={() => setBilling(cycle)} />
              {cycle === 'monthly' ? '月付' : '年付'}
              {cycle === 'yearly' && badge ? (
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold',
                  billing === cycle ? 'bg-[#0A0A0A]/15 text-[#0A0A0A]' : 'bg-[#22C55E]/15 text-[#4ADE80]')}>{badge}</span>
              ) : null}
            </label>
          );
        })}
      </div>

      <div className={cn('mx-auto grid w-full gap-6', shown.length >= 3 ? 'max-w-6xl lg:grid-cols-3' : 'max-w-4xl md:grid-cols-2')}>
        {shown.map(card => (
          <PriceCard key={card.key} card={card} billing={billing} showResult={showResult[card.key] === true}
            membershipHref={membershipHref} />
        ))}
      </div>
    </div>
  );
}

/**
 * The membership page opens the matching payment window from these parameters (PAY-STRIPE-MP step 5, #961); the
 * server decides whether the $49 first month or the founder price applies. Founder is Gold yearly.
 */
export function purchaseHref(membershipHref: string, card: LandingCard['key'], billing: PaywallBilling) {
  const params = new URLSearchParams({ buy: card === 'pro' ? 'pro' : 'gold', cycle: billing });
  return `${membershipHref}${membershipHref.includes('?') ? '&' : '?'}${params}`;
}

function PriceCard({ card, billing, showResult, membershipHref }: {
  card: LandingCard; billing: PaywallBilling; showResult: boolean; membershipHref: string;
}) {
  const quote = card.quotes[billing];
  const ready = card.checkoutReady[billing];
  return (
    <section data-testid={`landing-plan-${card.key}`} aria-label={card.name}
      className={cn('relative grid content-start gap-4 rounded-2xl p-6',
        card.recommended ? 'border-2 border-[#FFD700]/60 bg-gradient-to-b from-[#FFD700]/10 to-[#141414]' : 'border border-[#2A2A2A] bg-[#141414]')}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-lg font-bold text-white">{card.name}</p>
        {card.recommended ? (
          <span className="rounded-full bg-[#FFD700] px-2.5 py-0.5 text-xs font-bold text-[#0A0A0A]">推荐</span>
        ) : null}
      </div>
      {showResult ? <p className="text-sm font-semibold leading-relaxed text-[#FFD700]">{card.result.text}</p> : null}

      {quote ? (
        <div className="grid gap-1">
          {quote.tag ? (
            <span className="w-fit rounded-full bg-[#22C55E]/15 px-2 py-0.5 text-xs font-semibold text-[#4ADE80]">{quote.tag}</span>
          ) : null}
          <p className="flex flex-wrap items-baseline gap-x-2">
            {quote.strike ? <s className="text-lg text-[#7d7d7d]">{quote.strike}</s> : null}
            <b className="text-4xl text-white">{quote.price}</b>
            <span className="text-sm text-[#9A9A9A]">{quote.per}</span>
          </p>
          {quote.saving ? <p className="text-sm text-[#4ADE80]">{quote.saving}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-[#9A9A9A]">{card.missingNote[billing] ?? '暂不提供'}</p>
      )}

      {quote ? (
        <div className="grid gap-2">
          <Link href={ready ? purchaseHref(membershipHref, card.key, billing) : '/contact'}
            className={cn('rounded-xl px-4 py-3 text-center text-sm font-semibold transition-colors',
              card.recommended ? 'bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A]'
                : 'border border-[#333333] bg-[#1F1F1F] text-white hover:border-[#FFD700]')}>
            {ready ? card.cta : '联系我们'}
          </Link>
          <p data-testid={`landing-renewal-${card.key}`} className="text-xs leading-relaxed text-[#9A9A9A]">{quote.renewal}</p>
        </div>
      ) : null}
      <p className="border-t border-[#262626] pt-3 text-sm text-[#B0B0B0]">适合：{card.fit}</p>
    </section>
  );
}
