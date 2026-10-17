/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight, Check, MessageCircle, Sparkles } from 'lucide-react';
import page from '@/components/landing/preview-j/j.module.css';
import { WeekJ } from '@/components/landing/preview-j/WeekJ';
import { HERO } from '@/lib/landing/landing-copy';
import { J_HERO_PROMISE } from '@/lib/landing/landing-copy-j';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { L_HERO_FLOW } from '@/lib/landing/landing-copy-l';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import styles from './m.module.css';

/**
 * Sample M's first screen: sample L's words — the title, the promise, the button and its note — then L's three parts
 * (you say, the coach does, you get) as one row of "what you get", each coach line behind its capability. Nothing
 * waits to appear. The product window is the fixed one beside the page on a computer; on a phone (and with reduced
 * motion) the positioning conversation sits right under the row.
 */
export function HeroM({ note, flags }: { note: string; flags: LandingFlags }) {
  const does = visibleItems(flags, L_HERO_FLOW.coachDoes.items);
  return (
    <section aria-labelledby="hero-title" className={styles.hero} data-region="首屏">
      <div className={page.wrap}>
        <div className={styles.heroText} data-region="标题和按钮">
          <h1 id="hero-title" className={styles.heroTitle}>
            <span>{HERO.title.slice(0, HERO.title.lastIndexOf(' '))}</span>{' '}
            <span>{HERO.title.slice(HERO.title.lastIndexOf(' ') + 1)}</span>
          </h1>
          <p className={styles.promise}>{J_HERO_PROMISE.split(/(?<=，)/).map(part => <span key={part}>{part}</span>)}</p>
          <div className={styles.actions}>
            <Link href={SIGNUP_CTA_HREF} className={page.pill}>{HERO.primaryCta}<ArrowRight size={18} aria-hidden="true" /></Link>
            <p className={styles.note}>{note}</p>
          </div>
        </div>

        <figure className={styles.flow} aria-label={L_HERO_FLOW.label} data-region="三步图示">
          <div className={styles.flowStep}>
            <p className={styles.flowTitle}><MessageCircle size={16} aria-hidden="true" />{L_HERO_FLOW.youSay.title}</p>
            <p className={styles.bubble}>{L_HERO_FLOW.youSay.text}</p>
          </div>
          <div className={styles.flowStep}>
            <p className={styles.flowTitle}><img src="/graylum-logo.png" alt="" />{L_HERO_FLOW.coachDoes.title}</p>
            <ul className={styles.does}>
              {does.map(item => <li key={item.text}><Check size={15} aria-hidden="true" />{item.text}</li>)}
            </ul>
          </div>
          <div className={styles.flowStep} data-result="">
            <p className={styles.flowTitle}><Sparkles size={16} aria-hidden="true" />{L_HERO_FLOW.youGet.title}</p>
            <p className={styles.result}>{L_HERO_FLOW.youGet.text}</p>
          </div>
        </figure>

        <div className={styles.shot} data-fade=""><WeekJ still={0} fromTop /></div>
      </div>
    </section>
  );
}
