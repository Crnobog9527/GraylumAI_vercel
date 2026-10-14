/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ArrowRight, Plus } from 'lucide-react';
import { depthClass, SplitText } from '@/components/public-site/motion/depth-text';
import { FINAL_ACTION, HOW_IT_WORKS, VOICE_WALL, type GatedText, type VoiceNote } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE, type LandingFaqGroup } from '@/lib/landing/landing-faq';
import type { FlowStep } from '@/lib/landing/landing-flow';
import type { SampleReport } from '@/lib/landing/landing-samples';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { SampleReportsH } from './SampleReportsH';
import { ScenesH } from './ScenesH';
import styles from './h.module.css';

const SIDES = [1, 0, -1] as const;

/** A section heading that rises in character by character when it scrolls into view. */
export function Heading({ id, text, small = false }: { id?: string; text: string; small?: boolean }) {
  const Tag = small ? 'h3' : 'h2';
  return <Tag id={id} className={small ? styles.displaySmall : styles.display}><SplitText text={text} mode="reveal" /></Tag>;
}

/** Section 2: each complaint and its answer as one glass card, rising out of depth from alternating sides. */
export function VoiceWallH({ notes }: { notes: readonly VoiceNote[] }) {
  if (notes.length === 0) return null;
  return (
    <section aria-labelledby="voice-title" className={cn(styles.section, styles.deferred)}>
      <div className={styles.sectionHead}>
        <Heading id="voice-title" text={VOICE_WALL.title} />
        <p className={cn(styles.lede, depthClass.reveal)} data-reveal="">{VOICE_WALL.lede}</p>
      </div>
      <ul className={styles.wall}>
        {notes.map((note, index) => (
          <li key={note.id} className={cn(styles.wallItem, depthClass.depthSide)} style={{ '--side': SIDES[index % 3] } as CSSProperties}>
            <article data-tilt="" className={cn(styles.wallCard, styles.glass, depthClass.tilt, depthClass.sheen)}>
              <figure className={styles.note}>
                <blockquote>「{note.quote}」</blockquote>
                <figcaption>{note.source}{note.translated ? ` · ${VOICE_WALL.translatedLabel}` : ''}</figcaption>
              </figure>
              <div className={styles.answer}>
                <p className={styles.answerLabel}>教练怎么做</p>
                <p>{note.answer}</p>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Section 3: the promise, the nine steps as typed-out conversations, the sample reports and "什么时候拿到什么". */
export function HowItWorksH({ promise, steps, reports, timeline }: {
  promise: readonly GatedText[];
  steps: readonly FlowStep[];
  reports: readonly SampleReport[];
  timeline: readonly GatedText[];
}) {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className={cn(styles.section, styles.sheet, styles.glass)}>
      <div className={styles.sectionHead}>
        <Heading id="how-title" text={HOW_IT_WORKS.title} />
        <p className={cn(styles.promise, depthClass.reveal)} data-reveal="">{promise.map(part => part.text).join('')}</p>
      </div>
      <ScenesH steps={steps} />
      <SampleReportsH reports={reports} />
      {timeline.length > 0 ? (
        <div className={styles.when}>
          <Heading text={HOW_IT_WORKS.timelineTitle} small />
          <ol>
            {timeline.map((item, index) => (
              <li key={item.text} data-reveal="" className={cn(styles.whenItem, styles.glass, depthClass.reveal)}
                style={{ '--d': index } as CSSProperties}>
                <span className={cn(styles.whenIndex, depthClass.pop)} aria-hidden="true">{index + 1}</span>{item.text}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

/** Section 5: the groups side by side on glass, so more questions show per screen. */
export function FaqH({ groups }: { groups: readonly LandingFaqGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section id="faq" aria-labelledby="faq-title" className={cn(styles.section, styles.deferred)}>
      <Heading id="faq-title" text={LANDING_FAQ_TITLE} />
      <div className={styles.faqGroups}>
        {groups.map((group, index) => (
          <div key={group.title} className={cn(styles.faqSlot, depthClass.depth)} style={{ '--d': index } as CSSProperties}>
            <div className={cn(styles.faqGroup, styles.glass)}>
              <h3 className={styles.faqGroupTitle}>{group.title}</h3>
              {group.items.map(item => (
                <details key={item.id} id={item.id} className={styles.faqItem}>
                  <summary><span>{item.question}</span><Plus size={16} aria-hidden="true" /></summary>
                  <div>{item.answer.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
                </details>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Section 6: the close on a glass sheet lit from inside, the two paths side by side and one button. */
export function FinalH({ showStack, founderSeats, note }: { showStack: boolean; founderSeats: number | null; note: string }) {
  return (
    <section aria-labelledby="final-title" className={cn(styles.section, styles.final, styles.deferred)}>
      <span className={styles.finalLight} aria-hidden="true"><i /><i /><i /></span>
      <Heading id="final-title" text={FINAL_ACTION.title} />
      <ul className={styles.paths}>
        {FINAL_ACTION.paths.map((path, index) => (
          <li key={path} data-path={index === 0 ? 'alone' : 'coach'} data-reveal="" className={depthClass.reveal}
            style={{ '--d': index + 1 } as CSSProperties}>{path}</li>
        ))}
      </ul>
      {showStack ? <p className={styles.stack}><b>{FINAL_ACTION.stackLabel}</b>{FINAL_ACTION.stack.text}</p> : null}
      {founderSeats !== null ? (
        <p className={styles.founder}>{FINAL_ACTION.founderLine}<span>还剩 {founderSeats} 个名额</span></p>
      ) : null}
      <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillInk, styles.pillLarge, styles.pillGlow)}>
        {FINAL_ACTION.cta}<ArrowRight size={17} aria-hidden="true" />
      </Link>
      <p className={styles.finalNote}>{note}</p>
    </section>
  );
}
