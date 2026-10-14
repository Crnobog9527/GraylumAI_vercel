/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight, Plus } from 'lucide-react';
import { FINAL_ACTION, HERO_H } from '@/lib/landing/landing-copy';
import { J_FAQ_REWORDS, J_FINAL } from '@/lib/landing/landing-copy-j';
import { LANDING_FAQ_TITLE, type LandingFaqGroup } from '@/lib/landing/landing-faq';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import styles from './sections-j.module.css';
import page from './j.module.css';

/** Applies sample J's softened FAQ wording (J_FAQ_REWORDS) to one answer paragraph. */
export function rewordFaq(text: string) {
  return J_FAQ_REWORDS.reduce((current, [from, to]) => current.replace(from, to), text);
}

/** The FAQ, groups side by side on a wide screen; every answer starts closed (Owner 2026-10-15). */
export function FaqJ({ groups }: { groups: readonly LandingFaqGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section id="faq" aria-labelledby="faq-title" className={page.section} data-zone="faq" data-band="tint">
      <div className={page.wrap}>
        <h2 id="faq-title" className={page.display}>{LANDING_FAQ_TITLE}</h2>
        <div className={styles.faqGroups}>
          {groups.map(group => (
            <div key={group.title} className={styles.faqGroup}>
              <h3>{group.title}</h3>
              {group.items.map(item => (
                <details key={item.id} id={item.id} className={styles.faqItem}>
                  <summary><span>{item.question}</span><Plus size={18} aria-hidden="true" /></summary>
                  <div>{item.answer.map(paragraph => <p key={paragraph}>{rewordFaq(paragraph)}</p>)}</div>
                </details>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The close (Owner 2026-10-15): one push from the visitor's side — the result they want after the whole page, one
 * button, the same note as the first screen. The founder offer is no longer on this page.
 */
export function FinalJ() {
  const final = J_FINAL.versions[0];
  return (
    <section aria-labelledby="final-title" className={page.section} data-zone="final">
      <div className={page.wrap}>
        <div className={styles.final}>
          <h2 id="final-title" className={page.display}>{final.title}</h2>
          <p className={styles.finalLine}>{final.line}</p>
          <Link href={SIGNUP_CTA_HREF} className={page.pill}>{FINAL_ACTION.cta}<ArrowRight size={18} aria-hidden="true" /></Link>
          <p className={styles.finalNote}>{HERO_H.ctaNote}</p>
        </div>
      </div>
    </section>
  );
}
