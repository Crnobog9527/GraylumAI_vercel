/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { RevealOnScroll } from '@/components/landing/offer/RevealOnScroll';
import { HERO, HOW_IT_WORKS, VOICE_WALL, type GatedText, type VoiceNote } from '@/lib/landing/landing-copy';
import { FLOW_NOTE_LABEL, PUBLISH_PLATFORMS, type FlowStep } from '@/lib/landing/landing-flow';
import type { SampleReport } from '@/lib/landing/landing-samples';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { ESampleReports } from './ESampleReports';
import { ScrollFill } from './ScrollFill';
import styles from './e.module.css';

/** Module 1: the film card. The H1 paints with the HTML; only the ring light behind it animates, once. */
export function EHero({ note }: { note: string }) {
  return (
    <section className={styles.film} aria-labelledby="e-hero-title">
      <span aria-hidden="true" className={styles.ring} />
      <span aria-hidden="true" className={styles.floor} />
      <div className={styles.heroText}>
        <h1 id="e-hero-title" className={styles.h1}>{HERO.title}</h1>
        <p className={styles.promise}>{HERO.promise}</p>
        <div className={styles.actions}>
          <Link href={SIGNUP_CTA_HREF} className={styles.pillLight}>{HERO.primaryCta}</Link>
          <a href="#how-it-works" className={styles.pillGhost}>{HERO.secondaryCta}</a>
        </div>
        <p className={styles.heroNote}>{note}</p>
      </div>
    </section>
  );
}

/** Module 2: the sticky-note wall as one yellow panel; each answer arrives just after its complaint. */
export function EVoiceWall({ notes }: { notes: readonly VoiceNote[] }) {
  if (notes.length === 0) return null;
  return (
    <section aria-labelledby="e-voice-title" className={styles.section}>
      <div className={styles.wrap}>
        <div className={styles.headRow}>
          <h2 id="e-voice-title" className={styles.display}>{VOICE_WALL.title}</h2>
          <p className={styles.lede}>{VOICE_WALL.lede}</p>
        </div>
        <RevealOnScroll className={styles.notePanel}>
          {notes.map(note => (
            <div key={note.id} data-reveal-row="" className={styles.noteRow}>
              <figure className={styles.quote}>
                <blockquote>「{note.quote}」</blockquote>
                <figcaption>{note.source}{note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}</figcaption>
              </figure>
              <div className={styles.answer}>
                <p className={styles.answerLabel}>教练怎么做</p>
                <p>{note.answer}</p>
              </div>
            </div>
          ))}
        </RevealOnScroll>
      </div>
    </section>
  );
}

function PlatformMarquee() {
  // Listed twice so the strip loops without a gap; the second copy is hidden from assistive technology.
  return (
    <div className={styles.marquee}>
      <ul className={styles.marqueeTrack} aria-label="可发布的平台">
        {PUBLISH_PLATFORMS.map(name => <li key={name}>{name}</li>)}
        {PUBLISH_PLATFORMS.map(name => <li key={`${name}-again`} aria-hidden="true">{name}</li>)}
      </ul>
    </div>
  );
}

/**
 * Module 3: the promise (filled as it is read), the real conversation demo, the walk-through as a timeline whose
 * rail fills while scrolling, the sample reports and "什么时候拿到什么". The demo window is the #893 component
 * unchanged; the walk-through keeps its text and drops the dark screen mocks, since the demo now shows the screen.
 */
export function EHowItWorks({ promise, steps, reports, timeline }: {
  promise: readonly GatedText[];
  steps: readonly FlowStep[];
  reports: readonly SampleReport[];
  timeline: readonly GatedText[];
}) {
  return (
    <section id="how-it-works" aria-labelledby="e-how-title" className={cn(styles.section, styles.anchor)}>
      <div className={styles.wrap}>
        <h2 id="e-how-title" className={styles.display}>{HOW_IT_WORKS.title}</h2>
        <ScrollFill text={promise.map(part => part.text).join('')} />
        <div className={styles.demoStage}><LazyDemo /></div>
        {steps.length > 0 ? (
          <ol className={styles.steps}>
            {steps.map((step, index) => (
              <li key={step.id} id={step.id} className={styles.step}>
                <span className={styles.stepNum} aria-hidden="true">{index + 1}</span>
                <div className={styles.stepBody}>
                  <h3 className={styles.stepTitle}>{step.title}</h3>
                  <p className={styles.stepDemo}>{step.demo}</p>
                  {step.mock === 'publish' ? <PlatformMarquee /> : null}
                </div>
                <div className={styles.why}>
                  <p className={styles.whyLabel}>{FLOW_NOTE_LABEL}</p>
                  <p>{step.note}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        <ESampleReports reports={reports} />
        {timeline.length > 0 ? (
          <div className={styles.when}>
            <h3 className={styles.h3}>{HOW_IT_WORKS.timelineTitle}</h3>
            <ol className={styles.whenList}>
              {timeline.map((item, index) => (
                <li key={item.text} className={styles.whenItem}><span aria-hidden="true">{index + 1}</span>{item.text}</li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}
