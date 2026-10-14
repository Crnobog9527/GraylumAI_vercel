/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import { ArrowRight, Box, Lightbulb, Library, MessageCircleQuestion, Scale } from 'lucide-react';
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { H_EXPERT } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import styles from './h.module.css';
import hero from './hero-h.module.css';

const LAYERS = [
  { icon: Library, label: H_EXPERT.layers[0] },
  { icon: Box, label: H_EXPERT.layers[1] },
  { icon: Scale, label: H_EXPERT.layers[2] },
] as const;

/**
 * The second screen: the product at work (the real conversation components, opening on the step summary and
 * confirming the step), then what a general AI cannot give — the coach is built on a social-media specialist's
 * nine years: experience → knowledge base, Skills and judgement → every question and suggestion. The heading and
 * body are the Owner's to write; until then they show as placeholders. The pieces drift as the page scrolls.
 */
export function DiffBandH() {
  return (
    <section aria-labelledby="expert-title" className={cn(styles.section, hero.band)}>
      <div className={cn(styles.demoFrame, hero.drift)} style={{ '--drift': '28px' } as CSSProperties}>
        <LazyDemo start="summary" />
      </div>
      <div className={hero.expert}>
        <div className={hero.expertText}>
          <h2 id="expert-title" className={hero.placeholder}>{H_EXPERT.titlePlaceholder}</h2>
          <p className={hero.placeholder}>{H_EXPERT.bodyPlaceholder}</p>
        </div>
        <ol className={hero.flow} aria-label={H_EXPERT.flowLabel}>
          <li className={cn(hero.source, hero.drift)} style={{ '--drift': '18px' } as CSSProperties}>
            <b>{H_EXPERT.years}</b><span>{H_EXPERT.source}</span>
          </li>
          <li className={hero.arrow} aria-hidden="true"><ArrowRight size={20} /></li>
          <li className={hero.layers}>
            {LAYERS.map(({ icon: Icon, label }, index) => (
              <span key={label} className={hero.drift} style={{ '--drift': `${12 + index * 14}px` } as CSSProperties}>
                <Icon size={17} strokeWidth={1.8} aria-hidden="true" />{label}
              </span>
            ))}
          </li>
          <li className={hero.arrow} aria-hidden="true"><ArrowRight size={20} /></li>
          <li className={cn(hero.output, hero.drift)} style={{ '--drift': '36px' } as CSSProperties}>
            <span><MessageCircleQuestion size={17} strokeWidth={1.8} aria-hidden="true" />{H_EXPERT.outputs[0]}</span>
            <span><Lightbulb size={17} strokeWidth={1.8} aria-hidden="true" />{H_EXPERT.outputs[1]}</span>
          </li>
        </ol>
      </div>
    </section>
  );
}
