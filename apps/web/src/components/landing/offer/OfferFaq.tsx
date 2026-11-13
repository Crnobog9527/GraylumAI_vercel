/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Plus } from 'lucide-react';
import faq from '@/components/landing/preview-j/sections-j.module.css';
import article from '@/components/public-site/article.module.css';
import { cn } from '@/lib/utils';
import { LANDING_FAQ_TITLE, type LandingFaqGroup } from '@/lib/landing/landing-faq';
import styles from './offer.module.css';
import { FounderOnly } from './LiveFounderSeats';

/**
 * FAQ in three groups, collapsed by default with native <details> (no client JS). The answer text is
 * in the HTML even while collapsed, and matches the FAQPage JSON-LD word for word. Shown on /faq in the home page's look
 * (Owner 2026-11-14, PUBLIC-SITE): the home page FAQ's groups and rows (sections-j.module.css), without its rewording, so
 * the words stay the structured data's.
 */
export function OfferFaq({ groups }: { groups: readonly LandingFaqGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section id="faq" aria-labelledby="faq-title" className={cn(styles.deferred, article.section)} data-zone="faq">
      <h2 id="faq-title">{LANDING_FAQ_TITLE}</h2>
      <div className={faq.faqGroups}>
        {groups.map(group => (
          <div key={group.title} className={faq.faqGroup}>
            <h3>{group.title}</h3>
            {group.items.map(item => {
              const entry = (
                <details key={item.id} id={item.id} className={faq.faqItem}>
                  <summary><span>{item.question}</span><Plus size={18} aria-hidden="true" /></summary>
                  <div>{item.answer.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
                </details>
              );
              // Founder entries leave with the founder card when the live seat count reaches 0.
              return item.needs.includes('founder') ? <FounderOnly key={item.id}>{entry}</FounderOnly> : entry;
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
