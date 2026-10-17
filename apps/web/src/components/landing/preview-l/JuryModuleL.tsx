/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowRight, FileText, MessagesSquare, PenLine } from 'lucide-react';
import k from '@/components/landing/preview-k/k.module.css';
import { L_JURY } from '@/lib/landing/landing-copy-l-steps';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import styles from './steps-l.module.css';

/**
 * The jury after step one's report, larger (Owner 2026-10-17, round four: "这也是我们独家独创的一个功能"): its name and
 * Gold tag, one line of what it does, how it works in three beats, and a link to the jury's own page where its demo
 * now lives. Laid out like the product's own entry card (JuryEntry). Shown with the fusion flag only.
 * Round six (S10): beside it, the jury's flow drawn and played in a loop (JuryFlowL).
 */
export function JuryModuleL({ flags }: { flags: LandingFlags }) {
  if (!allOn(flags, L_JURY.needs)) return null;
  return (
    <section aria-labelledby="jury-title" className={k.section} data-region="评审团">
      <div className={k.wrap}>
        <div className={styles.jury}>
          <div className={styles.juryCopy}>
            <p className={styles.juryName}>{L_JURY.name}<span>{L_JURY.tier}</span></p>
            <h2 id="jury-title" className={styles.juryTitle}>{L_JURY.title}</h2>
            <ol className={styles.juryFlow}>
              {L_JURY.flow.map((beat, index) => (
                <li key={beat}>{index > 0 ? <ArrowRight size={16} aria-hidden="true" /> : null}{beat}</li>
              ))}
            </ol>
            <Link href={L_JURY.href} className={styles.juryLink}>{L_JURY.link}<ArrowRight size={16} aria-hidden="true" /></Link>
          </div>
          <JuryFlowL />
        </div>
      </div>
    </section>
  );
}

/**
 * How the jury works, drawn (Owner 2026-10-17, round six: "让用户通过这个可视化的动画，大概能了解到什么叫做评审团"), true to
 * FUSION-REVIEW: the report goes to three reviewers who find faults on their own; only where they disagree is there one
 * more round (two rounds at most); the lead writer puts it into a revised draft; every chapter, revision or original, is
 * the person's to pick. The parts light up in turn, in a loop; with reduced motion they are simply there. A picture.
 */
function JuryFlowL() {
  const a = L_JURY.anim;
  return (
    <figure className={styles.juryAnim} aria-label={a.label}>
      <p className={styles.jfReport} data-s={0}><FileText size={16} aria-hidden="true" />{a.report}</p>
      <ArrowDown className={styles.jfArrow} size={16} aria-hidden="true" data-s={0} />
      <ul className={styles.jfReviewers}>
        {a.reviewers.map((name, index) => (
          <li key={name} data-s={1} style={{ '--i': index } as CSSProperties}><b>{name}</b><span>{a.review}</span></li>
        ))}
      </ul>
      <ArrowDown className={styles.jfArrow} size={16} aria-hidden="true" data-s={1} />
      <p className={styles.jfDebate} data-s={2}>
        <MessagesSquare size={15} aria-hidden="true" />{a.debate}<small>{a.debateNote}</small>
      </p>
      <ArrowDown className={styles.jfArrow} size={16} aria-hidden="true" data-s={2} />
      <p className={styles.jfLead} data-s={3}><PenLine size={15} aria-hidden="true" />{a.lead}</p>
      <ArrowDown className={styles.jfArrow} size={16} aria-hidden="true" data-s={3} />
      <ul className={styles.jfChapters}>
        {a.chapters.map((title, index) => (
          <li key={title} data-s={4} style={{ '--i': index } as CSSProperties}>
            <span>{title}</span>
            <em data-on={index !== 1 || undefined}>{a.adopt}</em><em data-on={index === 1 || undefined}>{a.keep}</em>
          </li>
        ))}
      </ul>
    </figure>
  );
}
