/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import { BookOpen, BriefcaseBusiness, Clapperboard, Store, type LucideIcon } from 'lucide-react';
import { depthClass } from '@/components/public-site/motion/depth-text';
import { HERO_H } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import { CompareH } from './CompareH';
import styles from './h.module.css';
import hero from './hero-h.module.css';

/** The audience line's four questions, each with its own icon. The words are the Owner's, split at its breaks. */
const AUDIENCE_ICONS: readonly LucideIcon[] = [BookOpen, Store, BriefcaseBusiness, Clapperboard];
export function audienceParts(text: string) {
  return text.split(/(?<=？)|(?<=，)(?=或者)/).filter(Boolean);
}

/**
 * The second screen, one idea: who it is for. The Owner's four questions as four plain cards (the words unchanged,
 * split at their own breaks), then the summary line that ends in "从这里开始。".
 */
export function AudienceH() {
  return (
    <section aria-labelledby="audience-title" className={cn(styles.section, hero.audience)} data-region="适合谁">
      <h2 id="audience-title" className="sr-only">{HERO_H.audience}</h2>
      <ul className={hero.people} aria-hidden="true">
        {audienceParts(HERO_H.audience).map((part, index) => {
          const Icon = AUDIENCE_ICONS[index % AUDIENCE_ICONS.length];
          return (
            <li key={part} data-reveal="" className={depthClass.reveal} style={{ '--d': index } as CSSProperties}>
              <Icon size={22} strokeWidth={1.6} />{part}
            </li>
          );
        })}
      </ul>
      <p className={hero.summary}>{HERO_H.audienceSummary}</p>
    </section>
  );
}

/**
 * The third screen, one idea: why not a general AI. The Owner's difference line is the heading; under it, the
 * Owner's four-row comparison as pictures (CompareH).
 */
export function WhyH() {
  return (
    <section aria-labelledby="why-title" className={cn(styles.section, hero.why)} data-region="为什么不用通用 AI">
      <h2 id="why-title" className={hero.whyTitle}>{HERO_H.difference}</h2>
      <CompareH />
    </section>
  );
}
