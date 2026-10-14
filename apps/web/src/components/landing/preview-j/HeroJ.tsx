/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ArrowRight, BarChart3, Compass, Lightbulb, PenLine, Send, type LucideIcon } from 'lucide-react';
import { HERO, HERO_H } from '@/lib/landing/landing-copy';
import { J_FLYWHEEL } from '@/lib/landing/landing-copy-j';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import styles from './j.module.css';
import hero from './hero-j.module.css';

const NODE_ICONS: readonly LucideIcon[] = [Compass, Lightbulb, PenLine, Send, BarChart3];
/** Where each step sits on the wheel, clockwise from the top, as a share of the wheel's size. */
const nodeAt = (index: number, count: number) => {
  const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
  return { left: `${(50 + 41 * Math.cos(angle)).toFixed(2)}%`, top: `${(50 + 41 * Math.sin(angle)).toFixed(2)}%` };
};

/**
 * Sample J's first screen, one full screen like buffer.com's: the title large on the left (two lines), the promise,
 * one button and its note; on the right, the data-growth flywheel the coach builds with you — positioning, topics,
 * writing, publishing, reading the data, and back to adjusting — with the account's curve stepping up each lap.
 * Only the product's real steps, no numbers. With reduced motion the wheel holds still at its last lap.
 */
export function HeroJ() {
  const steps = J_FLYWHEEL.steps;
  return (
    <section aria-labelledby="hero-title" className={hero.hero}>
      <div className={cn(styles.wrap, hero.grid)}>
        <div className={hero.text}>
          <h1 id="hero-title" className={hero.title}>
            <span>{HERO.title.slice(0, HERO.title.lastIndexOf(' '))}</span>
            <span>{HERO.title.slice(HERO.title.lastIndexOf(' ') + 1)}</span>
          </h1>
          <p className={hero.promise}>{HERO.promise}</p>
          <div className={hero.actions}>
            <Link href={SIGNUP_CTA_HREF} className={styles.pill}>{HERO.primaryCta}<ArrowRight size={18} aria-hidden="true" /></Link>
            <p className={hero.note}>{HERO_H.ctaNote}</p>
          </div>
        </div>

        <figure className={hero.wheel} aria-label={J_FLYWHEEL.label}>
          <div className={hero.ring} aria-hidden="true">
            <svg viewBox="0 0 100 100" className={hero.track}>
              <circle cx="50" cy="50" r="41" />
              {steps.map((_, index) => {
                const a = -Math.PI / 2 + ((index + 0.5) / steps.length) * Math.PI * 2;
                const x = 50 + 41 * Math.cos(a);
                const y = 50 + 41 * Math.sin(a);
                const turn = (a * 180) / Math.PI + 90;
                return <path key={index} d="M -1.6 -1.4 L 0.6 0 L -1.6 1.4" transform={`translate(${x} ${y}) rotate(${turn})`} />;
              })}
            </svg>
            <span className={hero.orbit}><i /></span>
          </div>
          <ol className={hero.nodes}>
            {steps.map((step, index) => {
              const Icon = NODE_ICONS[index % NODE_ICONS.length];
              return (
                <li key={step} style={{ ...nodeAt(index, steps.length), '--i': index } as CSSProperties}>
                  <Icon size={16} strokeWidth={1.8} aria-hidden="true" />{step}
                </li>
              );
            })}
          </ol>
          <div className={hero.core} aria-hidden="true">
            <div className={hero.bars}>{[0, 1, 2, 3, 4].map(bar => <i key={bar} style={{ '--b': bar } as CSSProperties} />)}</div>
            <svg viewBox="0 0 100 60" className={hero.curve} preserveAspectRatio="none"><path d="M 4 54 C 30 50 44 40 58 30 S 84 10 96 6" /></svg>
          </div>
          <figcaption className={hero.caption}>{J_FLYWHEEL.caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}
