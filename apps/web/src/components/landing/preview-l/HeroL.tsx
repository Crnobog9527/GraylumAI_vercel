/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowRight, Check, MessageCircle, Sparkles } from 'lucide-react';
import hero from '@/components/landing/preview-j/hero-j.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { HERO } from '@/lib/landing/landing-copy';
import { J_HERO_PROMISE } from '@/lib/landing/landing-copy-j';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { L_HERO_FLOW } from '@/lib/landing/landing-copy-l';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import styles from './l.module.css';

/**
 * Sample L's first screen (Owner 2026-10-17): the title, the promise on one line on a computer (it breaks only at its
 * comma on a phone), the button and its note; on the right, no product window but one simple picture of what the coach
 * does for you: what you say in plain words, what the coach does (each line behind its capability), what you get. The
 * three parts light up in turn once, then rest; with reduced motion they are simply there.
 */
export function HeroL({ note, flags }: { note: string; flags: LandingFlags }) {
  const does = visibleItems(flags, L_HERO_FLOW.coachDoes.items);
  return (
    <section aria-labelledby="hero-title" className={hero.hero} data-zone="hero" data-region="首屏">
      <div className={cn(page.wrap, hero.grid, styles.heroGrid)}>
        <div className={cn(hero.text, styles.heroText)} data-region="标题和按钮">
          <h1 id="hero-title" className={hero.title}>
            <span>{HERO.title.slice(0, HERO.title.lastIndexOf(' '))}</span>
            <span>{HERO.title.slice(HERO.title.lastIndexOf(' ') + 1)}</span>
          </h1>
          <p className={cn(hero.promise, styles.promise)}>
            {J_HERO_PROMISE.split(/(?<=，)/).map(part => <span key={part}>{part}</span>)}
          </p>
          <div className={hero.actions}>
            <Link href={SIGNUP_CTA_HREF} className={page.pill}>{HERO.primaryCta}<ArrowRight size={18} aria-hidden="true" /></Link>
            <p className={hero.note}>{note}</p>
          </div>
        </div>

        <figure className={styles.flow} aria-label={L_HERO_FLOW.label} data-region="三步图示">
          <div className={styles.flowStep} style={{ '--n': 0 } as CSSProperties}>
            <p className={styles.flowTitle}><MessageCircle size={16} aria-hidden="true" />{L_HERO_FLOW.youSay.title}</p>
            <p className={styles.bubble}>{L_HERO_FLOW.youSay.text}</p>
          </div>
          <ArrowDown className={styles.flowArrow} size={20} aria-hidden="true" style={{ '--n': 1 } as CSSProperties} />
          <div className={styles.flowStep} style={{ '--n': 2 } as CSSProperties}>
            <p className={styles.flowTitle}><img src="/graylum-logo.png" alt="" />{L_HERO_FLOW.coachDoes.title}</p>
            <ul className={styles.does}>
              {does.map((item, index) => (
                <li key={item.text} style={{ '--i': index } as CSSProperties}><Check size={15} aria-hidden="true" />{item.text}</li>
              ))}
            </ul>
          </div>
          <ArrowDown className={styles.flowArrow} size={20} aria-hidden="true" style={{ '--n': 3 } as CSSProperties} />
          <div className={cn(styles.flowStep, styles.flowResult)} style={{ '--n': 4 } as CSSProperties}>
            <p className={styles.flowTitle}><Sparkles size={16} aria-hidden="true" />{L_HERO_FLOW.youGet.title}</p>
            <p className={styles.result}>{L_HERO_FLOW.youGet.text}</p>
          </div>
        </figure>
      </div>
    </section>
  );
}
