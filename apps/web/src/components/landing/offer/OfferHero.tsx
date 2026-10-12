/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowDown, ArrowRight } from 'lucide-react';
import { HERO } from '@/lib/landing/landing-copy';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';

/**
 * First screen: the page's only H1, the dream outcome and the two buttons. Server-rendered and
 * not animated, so the largest text paints with the HTML (no fade-in on the LCP element).
 */
export function OfferHero({ note }: { note: string }) {
  return (
    <section className="relative overflow-hidden px-4 pb-20 pt-16 sm:px-6 md:pb-28 md:pt-24 lg:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 70% 55% at 50% 0%, rgba(255,215,0,0.16) 0%, rgba(255,165,0,0.05) 45%, transparent 75%)',
        }}
      />
      <div className="relative mx-auto max-w-4xl text-center">
        <h1 className="text-4xl font-bold leading-tight text-white sm:text-5xl md:text-6xl">{HERO.title}</h1>
        <p className="mx-auto mt-6 max-w-3xl text-xl leading-relaxed text-[#FFD700] sm:text-2xl md:text-[1.75rem]">
          {HERO.promise}
        </p>
        <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <Link
            href={SIGNUP_CTA_HREF}
            className={cn('inline-flex items-center justify-center gap-2 rounded-xl px-8 py-4 text-lg font-bold',
              'bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A]',
              'transition-shadow hover:shadow-[0_0_24px_rgba(255,215,0,0.32)]')}
          >
            {HERO.primaryCta}
            <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </Link>
          <a
            href="#how-it-works"
            className={cn('inline-flex items-center justify-center gap-2 rounded-xl px-8 py-4 text-lg font-semibold',
              'border border-[#333333] text-white transition-colors hover:border-[#FFD700] hover:bg-[#FFD700]/10')}
          >
            {HERO.secondaryCta}
            <ArrowDown className="h-5 w-5" aria-hidden="true" />
          </a>
        </div>
        <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-[#9A9A9A]">{note}</p>
      </div>
    </section>
  );
}
