/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import hero from '@/components/landing/preview-j/hero-j.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { HERO } from '@/lib/landing/landing-copy';
import { J_HERO_PROMISE } from '@/lib/landing/landing-copy-j';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import styles from './l.module.css';

/**
 * Sample L's first screen. Round four (Owner 2026-10-17: "1-2 的这个模块其实都可以删掉……只保留 1-1……在 Hero 区居中"):
 * the title, the promise on one line on a computer (it breaks only at its comma on a phone), the button and its note,
 * centred; the three-step picture beside it is gone. The background stays as it was (its animation is a later round).
 */
export function HeroL({ note }: { note: string }) {
  return (
    <section aria-labelledby="hero-title" className={hero.hero} data-zone="hero" data-region="首屏">
      <div className={cn(page.wrap, styles.heroCentre)}>
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
      </div>
    </section>
  );
}
