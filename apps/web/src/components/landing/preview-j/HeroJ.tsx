/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { HERO } from '@/lib/landing/landing-copy';
import { J_HERO_PROMISE } from '@/lib/landing/landing-copy-j';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import styles from './j.module.css';
import hero from './hero-j.module.css';
import { WeekJ } from './WeekJ';

/**
 * Sample J's first screen, one full screen like buffer.com's: the title large on the left (two lines), the promise,
 * one button and its note; on the right, a small product window playing one week with the coach (WeekJ, the Owner's
 * option A of 2026-10-15). With reduced motion the window shows the week's last step, still.
 */
export function HeroJ({ note }: { note: string }) {
  return (
    <section aria-labelledby="hero-title" className={hero.hero} data-zone="hero">
      <div className={cn(styles.wrap, hero.grid)}>
        <div className={hero.text}>
          <h1 id="hero-title" className={hero.title}>
            <span>{HERO.title.slice(0, HERO.title.lastIndexOf(' '))}</span>
            <span>{HERO.title.slice(HERO.title.lastIndexOf(' ') + 1)}</span>
          </h1>
          <p className={hero.promise}>{J_HERO_PROMISE}</p>
          <div className={hero.actions}>
            <Link href={SIGNUP_CTA_HREF} className={styles.pill}>{HERO.primaryCta}<ArrowRight size={18} aria-hidden="true" /></Link>
            <p className={hero.note}>{note}</p>
          </div>
        </div>

        <WeekJ />
      </div>
    </section>
  );
}
