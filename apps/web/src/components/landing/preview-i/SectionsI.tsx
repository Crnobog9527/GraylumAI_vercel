/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight, Plus } from 'lucide-react';
import { reveal } from '@/components/public-site/motion/i-reveal';
import { FINAL_ACTION, HOW_IT_WORKS, VOICE_WALL, type GatedText, type VoiceNote } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE, type LandingFaqGroup } from '@/lib/landing/landing-faq';
import type { FlowStep } from '@/lib/landing/landing-flow';
import type { SampleReport } from '@/lib/landing/landing-samples';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { CoachMark } from './CoachMark';
import { order } from './shared';
import { SampleReportsI } from './SampleReportsI';
import { ScenesI } from './ScenesI';
import styles from './i.module.css';

/** Section 2: each complaint as the person's speech bubble, the coach's answer under it. Swipe row on a phone. */
export function VoiceWallI({ notes }: { notes: readonly VoiceNote[] }) {
  if (notes.length === 0) return null;
  return (
    <section data-i-reveal="" aria-labelledby="voice-title" className={cn(reveal.section, styles.section, styles.deferred)}>
      <div className={cn(styles.sectionHead, reveal.rise)}>
        <h2 id="voice-title" className={styles.display}>{VOICE_WALL.title}</h2>
        <p className={styles.lede}>{VOICE_WALL.lede}</p>
      </div>
      <ul className={styles.wall}>
        {notes.map((note, index) => (
          <li key={note.id} className={cn(styles.wallCard, styles.sticker, reveal.rise)} style={order(index + 1)}>
            <figure className={styles.note}>
              <blockquote>「{note.quote}」</blockquote>
              <figcaption>{note.source}{note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}</figcaption>
            </figure>
            <div className={styles.answer}>
              <p className={styles.answerLabel}><CoachMark className={styles.answerMark} />教练怎么做</p>
              <p>{note.answer}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Section 3: the promise, the nine steps as conversations, the sample reports and "什么时候拿到什么" as a road. */
export function HowItWorksI({ promise, steps, reports, timeline }: {
  promise: readonly GatedText[];
  steps: readonly FlowStep[];
  reports: readonly SampleReport[];
  timeline: readonly GatedText[];
}) {
  return (
    <section id="how-it-works" data-i-reveal="" aria-labelledby="how-title" className={cn(reveal.section, styles.section, styles.panel)}>
      <div className={cn(styles.sectionHead, reveal.rise)}>
        <h2 id="how-title" className={styles.display}>{HOW_IT_WORKS.title}</h2>
        <p className={styles.promise}>{promise.map(part => part.text).join('')}</p>
      </div>
      <div className={reveal.rise} style={order(2)}><ScenesI steps={steps} /></div>
      <SampleReportsI reports={reports} />
      {timeline.length > 0 ? (
        <div className={styles.when}>
          <h3 className={styles.displaySmall}>{HOW_IT_WORKS.timelineTitle}</h3>
          <ol>
            {timeline.map((item, index) => (
              <li key={item.text} className={reveal.pop} style={order(index + 3)}>
                <span className={styles.whenIndex} aria-hidden="true">{index + 1}</span>{item.text}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

/** Section 5: the groups side by side, so more questions show per screen. */
export function FaqI({ groups }: { groups: readonly LandingFaqGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section id="faq" data-i-reveal="" aria-labelledby="faq-title" className={cn(reveal.section, styles.section, styles.deferred)}>
      <h2 id="faq-title" className={cn(styles.display, reveal.rise)}>{LANDING_FAQ_TITLE}</h2>
      <div className={styles.faqGroups}>
        {groups.map((group, index) => (
          <div key={group.title} className={cn(styles.faqGroup, styles.sticker, reveal.rise)} style={order(index + 1)}>
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

/** Section 6 on a sunny sheet: the two paths side by side, the stack, founder seats and one button. */
export function FinalI({ showStack, founderSeats, note }: { showStack: boolean; founderSeats: number | null; note: string }) {
  return (
    <section data-i-reveal="" aria-labelledby="final-title" className={cn(reveal.section, styles.section, styles.final, styles.deferred)}>
      <h2 id="final-title" className={cn(styles.display, reveal.rise)}>{FINAL_ACTION.title}</h2>
      <ul className={styles.paths}>
        {FINAL_ACTION.paths.map((path, index) => (
          <li key={path} data-path={index === 0 ? 'alone' : 'coach'} className={reveal.rise} style={order(index + 1)}>{path}</li>
        ))}
      </ul>
      {showStack ? <p className={styles.stack}><b>{FINAL_ACTION.stackLabel}</b>{FINAL_ACTION.stack.text}</p> : null}
      {founderSeats !== null ? (
        <p className={styles.founder}>{FINAL_ACTION.founderLine}<span>还剩 {founderSeats} 个名额</span></p>
      ) : null}
      <Link href={SIGNUP_CTA_HREF} className={cn(styles.btn, styles.btnInk, styles.btnLarge, reveal.pop)} style={order(4)}>
        {FINAL_ACTION.cta}<ArrowRight size={17} aria-hidden="true" className={styles.nudge} />
      </Link>
      <p className={styles.finalNote}>{note}</p>
    </section>
  );
}
