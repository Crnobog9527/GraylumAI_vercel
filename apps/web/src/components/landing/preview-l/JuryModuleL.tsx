/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import k from '@/components/landing/preview-k/k.module.css';
import { L_JURY } from '@/lib/landing/landing-copy-l-steps';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { JuryCircuitL } from './JuryCircuitL';
import styles from './steps-l.module.css';

/**
 * The jury after step one's report, larger (Owner 2026-10-17, round four: "这也是我们独家独创的一个功能"): its name and
 * Gold tag, one line of what it does, how it works in three beats, and a link to the jury's own page where its demo
 * now lives. Laid out like the product's own entry card (JuryEntry). Shown with the fusion flag only.
 * Round six (S10): beside it, the jury's flow drawn; round nine (V4): a working circuit (JuryCircuitL).
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
          <JuryCircuitL />
        </div>
      </div>
    </section>
  );
}
