/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { PRICE_COMPARE, RISK_REVERSAL, type CompareRow, type GatedText } from '@/lib/landing/landing-copy';
import type { LandingPricing } from '@/lib/landing/landing-pricing';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { PriceCards } from './PriceCards';
import { FounderOnly, FounderSeatsLeft } from './LiveFounderSeats';
import { cn } from '@/lib/utils';
import styles from './offer.module.css';

/**
 * Price section (offer section 4): what the same work costs elsewhere (with sources), the cards,
 * then "先聊后买" right next to them. Only rows and promises whose capability is on are passed in.
 */
export function PriceSection({
  pricing,
  rows,
  risk,
  showResult,
  founderSeats,
  membershipHref,
}: {
  pricing: LandingPricing;
  rows: readonly CompareRow[];
  risk: readonly GatedText[];
  showResult: Record<string, boolean>;
  founderSeats: number | null;
  membershipHref: string;
}) {
  return (
    <section id="pricing" aria-labelledby="pricing-title"
      className={cn(styles.deferred, 'scroll-mt-20 border-t border-[#1F1F1F] px-4 py-20 sm:px-6 md:py-28 lg:px-8')}>
      <div className="mx-auto grid max-w-6xl gap-12">
        <h2 id="pricing-title" className="text-center text-3xl font-bold text-white md:text-4xl">{PRICE_COMPARE.title}</h2>

        {rows.length > 0 ? (
          <div className="mx-auto w-full max-w-3xl rounded-2xl border border-[#2A2A2A] bg-[#141414] p-6">
            <p className="text-base font-semibold text-white">{PRICE_COMPARE.lede}</p>
            <ul className="mt-4 grid gap-3">
              {rows.map((row, index) => (
                <li key={row.sourceId} className="flex flex-col gap-1 border-b border-[#232323] pb-3 text-sm sm:flex-row sm:justify-between sm:gap-4">
                  <span className="text-[#C8C8C8]">{row.label}<sup className="ml-0.5 text-[#8A8A8A]">{index + 1}</sup></span>
                  <span className="text-[#E5E5E5] sm:text-right">{row.price}</span>
                </li>
              ))}
            </ul>
            {pricing.proMonthly !== null ? (
              <p className="mt-5 text-lg font-bold text-[#FFD700]">{PRICE_COMPARE.ownPrice(formatUsd(pricing.proMonthly))}</p>
            ) : null}
          </div>
        ) : null}

        {pricing.founderOpen ? (
          <FounderOnly>
            <p className="text-center text-base font-semibold text-[#FFD700]">
              前 50 位创始会员，招满为止
              <FounderSeatsLeft rendered={founderSeats} className="ml-2 text-sm font-normal text-[#B0B0B0]" />
            </p>
          </FounderOnly>
        ) : null}

        {pricing.cards.length > 0 ? (
          <PriceCards cards={pricing.cards} yearlyBadge={pricing.yearlyBadge} yearlyBadgeWithoutFounder={pricing.yearlyBadgeWithoutFounder}
            showResult={showResult} membershipHref={membershipHref} />
        ) : (
          <p role="status" className="text-center text-sm text-[#9A9A9A]">
            会员方案暂时读不到，请稍后刷新，或先看<Link href="/pricing" className="text-[#FFD700] underline">价格页</Link>。
          </p>
        )}

        <div className="mx-auto w-full max-w-3xl rounded-2xl border border-[#22C55E]/30 bg-[#0F1A12] p-6">
          <p className="flex items-center gap-2 text-lg font-bold text-white">
            <ShieldCheck className="h-5 w-5 text-[#4ADE80]" aria-hidden="true" />
            {RISK_REVERSAL.title}
          </p>
          <ul className="mt-4 grid gap-2 text-sm leading-relaxed text-[#D0D0D0]">
            {risk.map(point => <li key={point.text} className="flex gap-2"><span aria-hidden="true">·</span>{point.text}</li>)}
          </ul>
        </div>

        {rows.length > 0 ? (
          <div className="mx-auto w-full max-w-3xl text-xs leading-relaxed text-[#7A7A7A]">
            <p>{PRICE_COMPARE.sourcesTitle}</p>
            <ol className="mt-2 grid gap-1">
              {rows.map((row, index) => <li key={row.sourceId}>{index + 1}. {PRICE_COMPARE.sources[row.sourceId]}</li>)}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}
