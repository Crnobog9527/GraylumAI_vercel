/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowDown, ArrowRight } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { IRevealRoot, IRoad } from '@/components/public-site/motion/IReveal';
import { reveal } from '@/components/public-site/motion/i-reveal';
import { IStoryBackdrop } from '@/components/public-site/motion/IStoryBackdrop';
import { LOGIN_HREF, SITE_CHROME } from '@/components/public-site/site-chrome';
import { HERO } from '@/lib/landing/landing-copy';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { HeroArtI } from './HeroArtI';
import { PriceI } from './PriceI';
import { FaqI, FinalI, HowItWorksI, VoiceWallI } from './SectionsI';
import type { LandingData } from './shared';
import styles from './i.module.css';

const CHROME = SITE_CHROME['zh-Hans'];
const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] as const;

/**
 * Style sample I, "a moving illustrated story": the page is one ordinary person's way from a blank account to a
 * running one. A line-drawn panorama along the bottom of the screen pans through that story as the visitor
 * scrolls (IStoryBackdrop), the first screen's phone fills in post by post, sections arrive with a spring and are
 * joined by a dashed road, and the nine steps are conversations that type themselves out. Bright sky-to-sun
 * palette with ink outlines and sticker shadows; dark only for lines, buttons and the visitor's own chat bubbles.
 * Copy and section order are the landing page's, as in samples D–G.
 */
export function SampleI({ data, siteName, membershipHref }: { data: LandingData; siteName: string; membershipHref: string }) {
  return (
    <div className={cn(light.light, styles.page)}>
      <IStoryBackdrop />
      <IRevealRoot />
      <nav aria-label="样稿切换" className={styles.sampleBar}>
        <span>不公开的风格样稿，文案为定稿原文</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'i' ? 'page' : undefined}>{id.toUpperCase()}</Link>
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
            <Link href={LOGIN_HREF} className={cn(styles.btn, styles.btnLight, styles.headerLogin)}>{CHROME.login}</Link>
            <Link href={SIGNUP_CTA_HREF} className={cn(styles.btn, styles.btnInk)}>{HERO.primaryCta}</Link>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section aria-labelledby="hero-title" className={styles.hero}>
          <div className={styles.heroText}>
            <h1 id="hero-title" className={styles.heroTitle}>{HERO.title}</h1>
            <p className={styles.heroPromise}>{HERO.promise}</p>
            <div className={styles.heroActions}>
              <Link href={SIGNUP_CTA_HREF} className={cn(styles.btn, styles.btnInk, styles.btnLarge)}>
                {HERO.primaryCta}<ArrowRight size={17} aria-hidden="true" className={styles.nudge} />
              </Link>
              <a href="#how-it-works" className={cn(styles.btn, styles.btnLight, styles.btnLarge)}>
                {HERO.secondaryCta}<ArrowDown size={17} aria-hidden="true" className={styles.nudgeDown} />
              </a>
            </div>
            <p className={styles.heroNote}>{data.heroNote}</p>
          </div>
          <div className={styles.heroArt}><HeroArtI /></div>
          <div data-i-reveal="" className={cn(reveal.section, styles.heroDemo)}>
            <div className={reveal.rise}><LazyDemo /></div>
          </div>
        </section>

        <IRoad />
        <VoiceWallI notes={data.notes} />
        <IRoad flip />
        <HowItWorksI promise={data.promise} steps={data.flowSteps} reports={data.sampleReports} timeline={data.timeline} />
        <IRoad />
        <PriceI data={data} membershipHref={membershipHref} />
        <IRoad flip />
        <FaqI groups={data.faqGroups} />
        <IRoad />
        <FinalI showStack={data.showStack} founderSeats={data.founderSeats} note={data.finalNote} />
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
