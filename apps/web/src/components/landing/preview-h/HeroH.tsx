/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight, BookOpen, BriefcaseBusiness, Clapperboard, Store, type LucideIcon } from 'lucide-react';
import { SplitText } from '@/components/public-site/motion/depth-text';
import { H_HERO_EXCHANGE, HERO, HERO_H } from '@/lib/landing/landing-copy';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { HeroFloatsH } from './HeroFloatsH';
import styles from './h.module.css';
import hero from './hero-h.module.css';

/** The audience line's four questions, each with its own icon. The words are the Owner's, split at its breaks. */
const AUDIENCE_ICONS: readonly LucideIcon[] = [BookOpen, Store, BriefcaseBusiness, Clapperboard];
export function audienceParts(text: string) {
  return text.split(/(?<=？)|(?<=，)(?=或者)/).filter(Boolean);
}

/**
 * The first screen, one full screen (Owner 2026-10-14, after buffer.com): centred, it answers what this is (H1),
 * what it does for you and who it is for (promise, the four kinds of people, the summary), why buy (the difference
 * line beside a two-message exchange: a general AI's answer and the coach's question) and what you get (the
 * result line), then one button. Real product pieces float around it on a wide screen (HeroFloatsH).
 */
export function HeroH() {
  const parts = audienceParts(HERO_H.audience);
  return (
    <section aria-labelledby="hero-title" className={hero.hero}>
      <HeroFloatsH />
      <div className={hero.center}>
        <h1 id="hero-title" className={hero.title}><SplitText text={HERO.title} mode="load" /></h1>
        <p className={hero.promise}>{HERO.promise}</p>
        <p className="sr-only">{HERO_H.audience}</p>
        <ul className={hero.people} aria-hidden="true">
          {parts.map((part, index) => {
            const Icon = AUDIENCE_ICONS[index % AUDIENCE_ICONS.length];
            return <li key={part}><Icon size={16} strokeWidth={1.8} />{part}</li>;
          })}
        </ul>
        <p className={hero.summary}>{HERO_H.audienceSummary}</p>
        <div className={hero.why}>
          <p className={hero.difference}>{HERO_H.difference}</p>
          <div className={hero.exchange}>
            <span className={hero.sample}>{H_HERO_EXCHANGE.label}</span>
            <div className={hero.generic}>
              <span>{H_HERO_EXCHANGE.genericWho}</span>
              <p>{H_HERO_EXCHANGE.generic}</p>
            </div>
            <div className={hero.coach}>
              <span>{H_HERO_EXCHANGE.coachWho}</span>
              <p>{H_HERO_EXCHANGE.coach}</p>
              <em>{H_HERO_EXCHANGE.coachPick}</em>
            </div>
          </div>
        </div>
        <p className={hero.result}>{HERO_H.result}</p>
        <div className={hero.actions}>
          <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillInk, styles.pillLarge)}>
            {HERO.primaryCta}<ArrowRight size={17} aria-hidden="true" />
          </Link>
          <p className={hero.note}>{HERO_H.ctaNote}</p>
        </div>
      </div>
    </section>
  );
}
