/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight, Plus } from 'lucide-react';
import { RevealOnScroll } from '@/components/landing/offer/RevealOnScroll';
import { FINAL_ACTION, HOW_IT_WORKS, VOICE_WALL, type GatedText, type VoiceNote } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE, type LandingFaqGroup } from '@/lib/landing/landing-faq';
import { FLOW_NOTE_LABEL, type FlowStep } from '@/lib/landing/landing-flow';
import type { SampleReport } from '@/lib/landing/landing-samples';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { InkFill, StepRail } from './motion';
import { SampleReportsD } from './SampleReportsD';
import styles from './d.module.css';

/** Section 2, the sticky-note wall: the complaint as a note, the coach's answer on a white sheet beside it. */
export function VoiceWallD({ notes }: { notes: readonly VoiceNote[] }) {
  if (notes.length === 0) return null;
  return (
    <section aria-labelledby="voice-title" className={cn(styles.section, styles.deferred)}>
      <div className={styles.splitHead}>
        <h2 id="voice-title" className={styles.display}>{VOICE_WALL.title}</h2>
        <p className={styles.lede}>{VOICE_WALL.lede}</p>
      </div>
      <RevealOnScroll className={styles.wall}>
        {notes.map(note => (
          <div key={note.id} data-reveal-row="" className={styles.wallRow}>
            <figure className={styles.note}>
              <blockquote>「{note.quote}」</blockquote>
              <figcaption>{note.source}{note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}</figcaption>
            </figure>
            <div className={cn(styles.answer, styles.ticked)}>
              <p className={styles.answerLabel}>教练怎么做</p>
              <p>{note.answer}</p>
            </div>
          </div>
        ))}
      </RevealOnScroll>
    </section>
  );
}

/**
 * Section 3 on the gold panel: the promise inks in as it scrolls, the nine steps run down a timeline, then
 * the sample reports and "什么时候拿到什么". The steps keep their verbatim title, demo line and note; the
 * clickable demo window sits in the first screen instead of per-step screen mocks.
 */
export function HowItWorksD({ promise, steps, reports, timeline }: {
  promise: readonly GatedText[];
  steps: readonly FlowStep[];
  reports: readonly SampleReport[];
  timeline: readonly GatedText[];
}) {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className={cn(styles.panel, styles.panelGold, styles.deferred)}>
      <h2 id="how-title" className={cn(styles.display, styles.displayHuge)}>{HOW_IT_WORKS.title}</h2>
      <InkFill text={promise.map(part => part.text).join('')} className={styles.inkFill} />
      {steps.length > 0 ? (
        <StepRail className={styles.steps}>
          {steps.map((step, index) => (
            <li key={step.id} id={step.id} className={styles.step}>
              <span className={styles.stepMark} aria-hidden="true">{index + 1}</span>
              <div className={styles.stepBody}>
                <h3 className={styles.stepTitle}>{step.title}</h3>
                <p className={styles.stepDemo}>{step.demo}</p>
              </div>
              <div className={styles.stepNote}>
                <p className={styles.stepNoteLabel}>{FLOW_NOTE_LABEL}</p>
                <p>{step.note}</p>
              </div>
            </li>
          ))}
        </StepRail>
      ) : null}
      <SampleReportsD reports={reports} />
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

/** Section 5: the heading holds the left column while the three groups scroll by on the right. */
export function FaqD({ groups }: { groups: readonly LandingFaqGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section id="faq" aria-labelledby="faq-title" className={cn(styles.section, styles.faq, styles.deferred)}>
      <h2 id="faq-title" className={cn(styles.display, styles.faqTitle)}>{LANDING_FAQ_TITLE}</h2>
      <div className={styles.faqGroups}>
        {groups.map(group => (
          <div key={group.title}>
            <h3 className={styles.faqGroupTitle}>{group.title}</h3>
            {group.items.map(item => (
              <details key={item.id} id={item.id} className={styles.faqItem}>
                <summary><span>{item.question}</span><Plus size={18} aria-hidden="true" /></summary>
                <div>{item.answer.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
              </details>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Section 6 on the dark close: the two paths side by side, the stack, founder seats and one button. */
export function FinalD({ showStack, founderSeats, note }: { showStack: boolean; founderSeats: number | null; note: string }) {
  return (
    <section aria-labelledby="final-title" className={cn(styles.panel, styles.panelInk, styles.final, styles.deferred)}>
      <h2 id="final-title" className={cn(styles.display, styles.displayHuge)}>{FINAL_ACTION.title}</h2>
      <ul className={styles.paths}>
        {FINAL_ACTION.paths.map((path, index) => (
          <li key={path} data-path={index === 0 ? 'alone' : 'coach'}>{path}</li>
        ))}
      </ul>
      {showStack ? <p className={styles.stack}><b>{FINAL_ACTION.stackLabel}</b>{FINAL_ACTION.stack.text}</p> : null}
      {founderSeats !== null ? (
        <p className={styles.founder}>{FINAL_ACTION.founderLine}<span>还剩 {founderSeats} 个名额</span></p>
      ) : null}
      <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillLight, styles.pillLarge)}>
        {FINAL_ACTION.cta}<ArrowRight size={18} aria-hidden="true" />
      </Link>
      <p className={styles.finalNote}>{note}</p>
    </section>
  );
}
