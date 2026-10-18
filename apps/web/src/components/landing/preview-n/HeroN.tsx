/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight, Check, MessageCircle, Sparkles } from 'lucide-react';
import page from '@/components/landing/preview-j/j.module.css';
import { HERO } from '@/lib/landing/landing-copy';
import { J_HERO_PROMISE } from '@/lib/landing/landing-copy-j';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { L_HERO_FLOW } from '@/lib/landing/landing-copy-l';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import styles from './n.module.css';

/** Two short facts the first screen may carry, each already said elsewhere on the page (null when it is not). */
export type HeroFacts = {
  /** From the voice wall's answer to p1 ("我们的 AI 教练 24 小时在线"); only while that note is shown. */
  online: { who: string; what: string } | null;
  /** From the sample reports' title ("先看成果：N 种人拿到的完整报告"); only while the reports are shown. */
  reports: { count: number; label: string } | null;
};

/**
 * Sample N's first screen as one block of cells (direction E): the big cell holds the title, the promise, the button
 * and its note, so the first five seconds say what it is, for whom and what you get; beside it, sample L's picture
 * of what the coach does for you as three cells (you say, the coach does — each line behind its capability — you
 * get); then the two small facts. No product window here, no animation that holds the first screen back. A phone
 * stacks the big cells first and sets the two facts side by side.
 */
export function HeroN({ note, flags, facts }: { note: string; flags: LandingFlags; facts: HeroFacts }) {
  const does = visibleItems(flags, L_HERO_FLOW.coachDoes.items);
  return (
    <section aria-labelledby="hero-title" className={styles.hero} data-zone="hero" data-region="首屏">
      <div className={styles.wrap}><div className={cn(styles.grid, styles.heroGrid)}>
        <div className={cn(styles.cell, styles.heroMain)} data-region="标题和按钮">
          <h1 id="hero-title" className={styles.heroTitle}>
            <span>{HERO.title.slice(0, HERO.title.lastIndexOf(' '))}</span>
            <span>{HERO.title.slice(HERO.title.lastIndexOf(' ') + 1)}</span>
          </h1>
          <p className={styles.promise}>{J_HERO_PROMISE.split(/(?<=，)/).map(part => <span key={part}>{part}</span>)}</p>
          <div className={styles.heroActions}>
            <Link href={SIGNUP_CTA_HREF} className={page.pill}>{HERO.primaryCta}<ArrowRight size={18} aria-hidden="true" /></Link>
            <p>{note}</p>
          </div>
        </div>

        <div role="group" aria-label={L_HERO_FLOW.label} className={styles.contents}>
          <div className={cn(styles.cell, styles.heroSay)} data-region="你说">
            <p className={styles.cellLabel}><MessageCircle size={15} aria-hidden="true" />{L_HERO_FLOW.youSay.title}</p>
            <p className={styles.bubble}>{L_HERO_FLOW.youSay.text}</p>
          </div>
          <div className={cn(styles.cell, styles.heroDoes)} data-region="AI 教练替你做">
            <p className={styles.cellLabel}><img src="/graylum-logo.png" alt="" />{L_HERO_FLOW.coachDoes.title}</p>
            <ul className={styles.does}>
              {does.map(item => <li key={item.text}><Check size={15} aria-hidden="true" />{item.text}</li>)}
            </ul>
          </div>
          <div className={cn(styles.cell, styles.heroGet)} data-region="你得到" data-key="">
            <p className={styles.cellLabel}><Sparkles size={15} aria-hidden="true" />{L_HERO_FLOW.youGet.title}</p>
            <p className={styles.result}>{L_HERO_FLOW.youGet.text}</p>
          </div>
        </div>

        {facts.online ? (
          <p className={cn(styles.cell, styles.fact)} data-region="在线时间">
            <span>{facts.online.who}</span><b>{facts.online.what}</b>
          </p>
        ) : null}
        {facts.reports ? (
          <a href="#samples" className={cn(styles.cell, styles.fact, styles.factLink)} data-region="样例数量">
            <b className={styles.factNumber}>{facts.reports.count}</b><span>{facts.reports.label}</span>
          </a>
        ) : null}
      </div></div>
    </section>
  );
}
