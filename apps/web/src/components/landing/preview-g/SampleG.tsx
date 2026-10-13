/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowDown, ArrowRight } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { displayFont } from '@/components/landing/preview-d/display-font';
import { ScrollBackdrop } from '@/components/public-site/motion/ScrollBackdrop';
import { LOGIN_HREF, SITE_CHROME } from '@/components/public-site/site-chrome';
import { HERO } from '@/lib/landing/landing-copy';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { PriceG } from './PriceG';
import { FaqG, FinalG, HowItWorksG, VoiceWallG } from './SectionsG';
import styles from './g.module.css';

const CHROME = SITE_CHROME['zh-Hans'];
const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
export type LandingData = ReturnType<typeof buildLandingPageData>;

/**
 * Style sample G: sample D's ploy.ai craft (rounded sheets, pill actions, heavy CJK headings) reworked after the
 * Owner's notes of 2026-10-14: a light page with dark only in small accents, one scroll-driven backdrop running
 * from top to bottom (the reusable ScrollBackdrop), the nine steps as clickable conversations, and SaaS density
 * so every screen, phone included, carries several selling points. Copy and section order are the landing page's.
 */
export function SampleG({ data, siteName, membershipHref }: { data: LandingData; siteName: string; membershipHref: string }) {
  return (
    <div className={cn(light.light, displayFont.variable, styles.page)}>
      <ScrollBackdrop />
      <nav aria-label="样稿切换" className={styles.sampleBar}>
        <span>不公开的风格样稿，文案为定稿原文</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'g' ? 'page' : undefined}>{id.toUpperCase()}</Link>
        ))}
      </nav>

      <header className={styles.header}>
        <div className={styles.headerBar}>
          <Link href="/landing" className={styles.brand}>
            <img src="/graylum-logo.svg" alt="" aria-hidden="true" width={24} height={24} />{siteName}
          </Link>
          <nav className={styles.nav} aria-label="主导航">
            {CHROME.nav.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          </nav>
          <div className={styles.headerActions}>
            <Link href={LOGIN_HREF} className={cn(styles.pill, styles.pillLight, styles.headerLogin)}>{CHROME.login}</Link>
            <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillDark)}>{HERO.primaryCta}</Link>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section aria-labelledby="hero-title" className={styles.hero}>
          <div className={styles.heroText}>
            <h1 id="hero-title" className={styles.heroTitle}>{HERO.title}</h1>
            <p className={styles.heroPromise}>{HERO.promise}</p>
          </div>
          <div className={styles.heroSide}>
            <div className={styles.heroActions}>
              <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillDark, styles.pillLarge)}>
                {HERO.primaryCta}<ArrowRight size={17} aria-hidden="true" />
              </Link>
              <a href="#how-it-works" className={cn(styles.pill, styles.pillLight, styles.pillLarge)}>
                {HERO.secondaryCta}<ArrowDown size={17} aria-hidden="true" />
              </a>
            </div>
            <p className={styles.heroNote}>{data.heroNote}</p>
          </div>
          <div className={styles.heroDemo}><LazyDemo /></div>
        </section>

        <VoiceWallG notes={data.notes} />
        <HowItWorksG promise={data.promise} steps={data.flowSteps} reports={data.sampleReports} timeline={data.timeline} />
        <PriceG data={data} membershipHref={membershipHref} />
        <FaqG groups={data.faqGroups} />
        <FinalG showStack={data.showStack} founderSeats={data.founderSeats} note={data.finalNote} />
      </main>

      <footer className={styles.footer}>
        <nav aria-label="页脚">
          {CHROME.nav.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          <Link href={LOGIN_HREF}>{CHROME.login}</Link>
        </nav>
        <p>© 2026 Grayscale Luminary LLC</p>
      </footer>
    </div>
  );
}
