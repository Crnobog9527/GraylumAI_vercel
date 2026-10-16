/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ArrowRight } from 'lucide-react';
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { depthClass, SplitText } from '@/components/public-site/motion/depth-text';
import { HERO } from '@/lib/landing/landing-copy';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import styles from './h.module.css';
import hero from './hero-h.module.css';

/**
 * The first screen (Owner's option A, 2026-10-14): only the title, the one-line promise, the button and, below them,
 * one large view of the real product — the conversation on the left, the positioning checklist on the right,
 * marked 示例 — that drifts gently as the page scrolls. About thirty characters of text and plenty of white.
 * On a desktop the text, the button and most of the product fit the first screen; on a phone the product peeks in
 * under the button, inviting the scroll.
 */
export function HeroH({ note }: { note: string }) {
  return (
    <section aria-labelledby="hero-title" className={hero.hero}>
      <div className={hero.center}>
        <h1 id="hero-title" className={hero.title}><SplitText text={HERO.title} mode="load" /></h1>
        <p className={hero.promise}>{HERO.promise}</p>
        <div className={hero.actions}>
          <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillInk, styles.pillLarge)}>
            {HERO.primaryCta}<ArrowRight size={17} aria-hidden="true" />
          </Link>
          <p className={hero.note}>{note}</p>
        </div>
      </div>
      <div className={cn(hero.product, depthClass.parallax)} style={{ '--speed': 0.3 } as CSSProperties}>
        <div className={styles.demoFrame}><LazyDemo start="summary" /></div>
      </div>
    </section>
  );
}
