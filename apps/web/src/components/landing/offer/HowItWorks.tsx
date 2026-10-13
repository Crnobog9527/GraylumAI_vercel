/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { HOW_IT_WORKS, type GatedText } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import styles from './offer.module.css';

/**
 * Module 3, "AI 教练怎么接手你的运营": the promise, then the walk-through and sample reports passed in as
 * children, then the "what you get when" timeline. Hidden promises are already filtered out by the page.
 */
export function HowItWorks({
  promise,
  timeline,
  children,
}: {
  promise: readonly GatedText[];
  timeline: readonly GatedText[];
  children?: ReactNode;
}) {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-title"
      className={cn(styles.deferred, 'scroll-mt-20 border-t border-[#1F1F1F] bg-[#0D0D0D] px-4 py-20 sm:px-6 md:py-28 lg:px-8')}>
      <div className="mx-auto max-w-5xl">
        <h2 id="how-it-works-title" className="text-center text-3xl font-bold text-white md:text-4xl">{HOW_IT_WORKS.title}</h2>
        <p className="mx-auto mt-6 max-w-3xl text-lg leading-relaxed text-[#C8C8C8]">
          {promise.map(part => part.text).join('')}
        </p>
        {children}
        {timeline.length > 0 ? (
          <div className="mx-auto mt-16 max-w-3xl">
            <h3 className="text-center text-xl font-semibold text-white">{HOW_IT_WORKS.timelineTitle}</h3>
            <ol className="mt-6 grid gap-3 md:grid-cols-3">
              {timeline.map((step, index) => (
                <li key={step.text} className="rounded-2xl border border-[#2A2A2A] bg-[#141414] p-4 text-sm leading-relaxed text-[#D0D0D0]">
                  <span className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-[#FFD700]/15 text-sm font-bold text-[#FFD700]">
                    {index + 1}
                  </span>
                  {step.text}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}
