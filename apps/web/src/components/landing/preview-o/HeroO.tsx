/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowRight, Check, MessageCircle, Sparkles } from 'lucide-react';
import page from '@/components/landing/preview-j/j.module.css';
import { HERO } from '@/lib/landing/landing-copy';
import { J_HERO_PROMISE } from '@/lib/landing/landing-copy-j';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { L_HERO_FLOW } from '@/lib/landing/landing-copy-l';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { StationO } from './RouteO';
import styles from './o.module.css';

/**
 * Sample O's first screen: sample L's content (the title, the promise, the button and its note; what you say → what the
 * coach does, each line behind its capability → what you get), set as the route's start: station 0 sits in the rail
 * beside the title. The three parts come in once with an ease-out; with reduced motion they are simply there.
 */
export function HeroO({ note, flags }: { note: string; flags: LandingFlags }) {
  const does = visibleItems(flags, L_HERO_FLOW.coachDoes.items);
  const cut = HERO.title.lastIndexOf(' ');
  return (
    <section aria-labelledby="hero-title" className={styles.hero} data-region="首屏">
      <div className={styles.wrap}>
        <div className={styles.heroGrid}>
          <div className={styles.heroText} data-region="标题和按钮">
            <StationO n="0" />
            <h1 id="hero-title" className={styles.heroTitle}>
              <span>{HERO.title.slice(0, cut)}</span>
              <span>{HERO.title.slice(cut + 1)}</span>
            </h1>
            <p className={styles.promise}>{J_HERO_PROMISE.split(/(?<=，)/).map(part => <span key={part}>{part}</span>)}</p>
            <div className={styles.heroActions}>
              <Link href={SIGNUP_CTA_HREF} className={page.pill}>{HERO.primaryCta}<ArrowRight size={18} aria-hidden="true" /></Link>
              <p>{note}</p>
            </div>
          </div>

          <figure className={styles.flow} aria-label={L_HERO_FLOW.label} data-region="三步图示">
            <div className={styles.flowStep} style={{ '--n': 0 } as CSSProperties}>
              <p className={styles.flowTitle}><MessageCircle size={16} aria-hidden="true" />{L_HERO_FLOW.youSay.title}</p>
              <p className={styles.bubble}>{L_HERO_FLOW.youSay.text}</p>
            </div>
            <ArrowDown className={styles.flowArrow} size={18} aria-hidden="true" style={{ '--n': 1 } as CSSProperties} />
            <div className={styles.flowStep} style={{ '--n': 2 } as CSSProperties}>
              <p className={styles.flowTitle}><img src="/graylum-logo.png" alt="" />{L_HERO_FLOW.coachDoes.title}</p>
              <ul className={styles.does}>
                {does.map((item, index) => (
                  <li key={item.text} style={{ '--i': index } as CSSProperties}><Check size={15} aria-hidden="true" />{item.text}</li>
                ))}
              </ul>
            </div>
            <ArrowDown className={styles.flowArrow} size={18} aria-hidden="true" style={{ '--n': 3 } as CSSProperties} />
            <div className={styles.flowStep} data-result="" style={{ '--n': 4 } as CSSProperties}>
              <p className={styles.flowTitle}><Sparkles size={16} aria-hidden="true" />{L_HERO_FLOW.youGet.title}</p>
              <p className={styles.result}>{L_HERO_FLOW.youGet.text}</p>
            </div>
          </figure>
        </div>
      </div>
    </section>
  );
}
