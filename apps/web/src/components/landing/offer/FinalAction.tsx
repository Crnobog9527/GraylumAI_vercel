/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { FINAL_ACTION } from '@/lib/landing/landing-copy';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import styles from './offer.module.css';
import { FounderOnly, FounderSeatsLeft } from './LiveFounderSeats';

/** Closing section (offer section 6): the two paths, the stack summary, founder seats, one button. */
export function FinalAction({ showStack, founderSeats, note }: { showStack: boolean; founderSeats: number | null; note: string }) {
  return (
    <section aria-labelledby="final-action-title" className={cn(styles.deferred, 'border-t border-[#1F1F1F] px-4 py-20 sm:px-6 md:py-28 lg:px-8')}>
      <div className="mx-auto max-w-3xl text-center">
        <h2 id="final-action-title" className="text-3xl font-bold text-white md:text-4xl">{FINAL_ACTION.title}</h2>
        <ul className="mt-10 grid gap-4 text-left md:grid-cols-2">
          {FINAL_ACTION.paths.map((path, index) => (
            <li key={path} className={cn('rounded-2xl p-5 text-base leading-relaxed',
              index === 0 ? 'border border-[#2A2A2A] bg-[#141414] text-[#9A9A9A]' : 'border border-[#FFD700]/50 bg-[#FFD700]/10 text-white')}>
              {path}
            </li>
          ))}
        </ul>
        {showStack ? (
          <p className="mt-8 text-base leading-relaxed text-[#C8C8C8]">
            <b className="text-white">{FINAL_ACTION.stackLabel}</b>{FINAL_ACTION.stack.text}
          </p>
        ) : null}
        {founderSeats !== null ? (
          <FounderOnly>
            <p className="mt-4 text-base font-semibold text-[#FFD700]">
              {FINAL_ACTION.founderLine}<FounderSeatsLeft rendered={founderSeats} className="ml-2 text-sm font-normal text-[#B0B0B0]" />
            </p>
          </FounderOnly>
        ) : null}
        <Link
          href={SIGNUP_CTA_HREF}
          className={cn('mt-10 inline-flex items-center justify-center gap-2 rounded-xl px-8 py-4 text-lg font-bold',
            'bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A] transition-shadow hover:shadow-[0_0_24px_rgba(255,215,0,0.32)]')}
        >
          {FINAL_ACTION.cta}
          <ArrowRight className="h-5 w-5" aria-hidden="true" />
        </Link>
        <p className="mt-4 text-sm text-[#9A9A9A]">{note}</p>
      </div>
    </section>
  );
}
