/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight, Plus } from 'lucide-react';
import { FINAL_ACTION, HOW_IT_WORKS, VOICE_WALL, type GatedText, type VoiceNote } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE, type LandingFaqGroup } from '@/lib/landing/landing-faq';
import type { FlowStep } from '@/lib/landing/landing-flow';
import type { SampleReport } from '@/lib/landing/landing-samples';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { SampleReportsG } from './SampleReportsG';
import { ScenesG } from './ScenesG';
import styles from './g.module.css';

/** Section 2: every complaint and its answer as one compact card; three across on desktop, a swipe row on a phone. */
export function VoiceWallG({ notes }: { notes: readonly VoiceNote[] }) {
  if (notes.length === 0) return null;
  return (
    <section aria-labelledby="voice-title" className={cn(styles.section, styles.deferred)}>
      <div className={styles.sectionHead}>
        <h2 id="voice-title" className={styles.display}>{VOICE_WALL.title}</h2>
        <p className={styles.lede}>{VOICE_WALL.lede}</p>
      </div>
      <ul className={styles.wall}>
        {notes.map(note => (
          <li key={note.id} className={styles.wallCard}>
            <figure className={styles.note}>
              <blockquote>「{note.quote}」</blockquote>
              <figcaption>{note.source}{note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}</figcaption>
            </figure>
            <div className={styles.answer}>
              <p className={styles.answerLabel}>教练怎么做</p>
              <p>{note.answer}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Section 3: the promise, the nine steps as clickable conversations, the sample reports and "什么时候拿到什么". */
export function HowItWorksG({ promise, steps, reports, timeline }: {
  promise: readonly GatedText[];
  steps: readonly FlowStep[];
  reports: readonly SampleReport[];
  timeline: readonly GatedText[];
}) {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className={cn(styles.section, styles.sheetPanel)}>
      <div className={styles.sectionHead}>
        <h2 id="how-title" className={styles.display}>{HOW_IT_WORKS.title}</h2>
        <p className={styles.promise}>{promise.map(part => part.text).join('')}</p>
      </div>
      <ScenesG steps={steps} />
      <SampleReportsG reports={reports} />
      {timeline.length > 0 ? (
        <div className={styles.when}>
          <h3 className={styles.displaySmall}>{HOW_IT_WORKS.timelineTitle}</h3>
          <ol>
            {timeline.map((item, index) => (
              <li key={item.text}><span className={styles.whenIndex} aria-hidden="true">{index + 1}</span>{item.text}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

/** Section 5: the groups side by side, so more questions show per screen. */
export function FaqG({ groups }: { groups: readonly LandingFaqGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section id="faq" aria-labelledby="faq-title" className={cn(styles.section, styles.deferred)}>
      <h2 id="faq-title" className={styles.display}>{LANDING_FAQ_TITLE}</h2>
      <div className={styles.faqGroups}>
        {groups.map(group => (
          <div key={group.title} className={styles.faqGroup}>
            <h3 className={styles.faqGroupTitle}>{group.title}</h3>
            {group.items.map(item => (
              <details key={item.id} id={item.id} className={styles.faqItem}>
                <summary><span>{item.question}</span><Plus size={16} aria-hidden="true" /></summary>
                <div>{item.answer.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
              </details>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Section 6 on a light gold sheet: the two paths side by side, the stack, founder seats and one button. */
export function FinalG({ showStack, founderSeats, note }: { showStack: boolean; founderSeats: number | null; note: string }) {
  return (
    <section aria-labelledby="final-title" className={cn(styles.section, styles.final, styles.deferred)}>
      <h2 id="final-title" className={styles.display}>{FINAL_ACTION.title}</h2>
      <ul className={styles.paths}>
        {FINAL_ACTION.paths.map((path, index) => (
          <li key={path} data-path={index === 0 ? 'alone' : 'coach'}>{path}</li>
        ))}
      </ul>
      {showStack ? <p className={styles.stack}><b>{FINAL_ACTION.stackLabel}</b>{FINAL_ACTION.stack.text}</p> : null}
      {founderSeats !== null ? (
        <p className={styles.founder}>{FINAL_ACTION.founderLine}<span>还剩 {founderSeats} 个名额</span></p>
      ) : null}
      <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillDark, styles.pillLarge)}>
        {FINAL_ACTION.cta}<ArrowRight size={17} aria-hidden="true" />
      </Link>
      <p className={styles.finalNote}>{note}</p>
    </section>
  );
}
