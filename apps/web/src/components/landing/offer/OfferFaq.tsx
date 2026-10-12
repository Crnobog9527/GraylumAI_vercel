/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LANDING_FAQ_TITLE, type LandingFaqGroup } from '@/lib/landing/landing-faq';
import styles from './offer.module.css';

/**
 * FAQ in three groups, collapsed by default with native <details> (no client JS). The answer text is
 * in the HTML even while collapsed, and matches the FAQPage JSON-LD word for word.
 */
export function OfferFaq({ groups }: { groups: readonly LandingFaqGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section id="faq" aria-labelledby="faq-title"
      className={cn(styles.deferred, 'scroll-mt-20 border-t border-[#1F1F1F] bg-[#0D0D0D] px-4 py-20 sm:px-6 md:py-28 lg:px-8')}>
      <div className="mx-auto max-w-3xl">
        <h2 id="faq-title" className="text-center text-3xl font-bold text-white md:text-4xl">{LANDING_FAQ_TITLE}</h2>
        {groups.map(group => (
          <div key={group.title} className="mt-10">
            <h3 className="mb-3 text-lg font-semibold text-[#FFD700]">{group.title}</h3>
            <div className="grid gap-3">
              {group.items.map(item => (
                <details key={item.id} id={item.id} className="group rounded-2xl border border-[#2A2A2A] bg-[#141414] open:border-[#FFD700]/40">
                  <summary className={cn('flex cursor-pointer list-none items-start justify-between gap-4 p-5',
                    'text-base font-semibold text-white [&::-webkit-details-marker]:hidden')}>
                    <span>{item.question}</span>
                    <ChevronDown className="mt-1 h-4 w-4 flex-shrink-0 text-[#9A9A9A] transition-transform group-open:rotate-180" aria-hidden="true" />
                  </summary>
                  <div className="grid gap-3 px-5 pb-5 text-sm leading-relaxed text-[#C8C8C8]">
                    {item.answer.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
                  </div>
                </details>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
