/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ArrowDown, ArrowRight } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { displayFont } from '@/components/landing/preview-d/display-font';
import { AuroraBackdrop } from '@/components/public-site/motion/AuroraBackdrop';
import { DepthStage } from '@/components/public-site/motion/DepthStage';
import { depthClass, SplitText } from '@/components/public-site/motion/depth-text';
import { LOGIN_HREF, SITE_CHROME } from '@/components/public-site/site-chrome';
import { HERO } from '@/lib/landing/landing-copy';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { PriceH } from './PriceH';
import { PaletteSwitchH } from './PaletteSwitchH';
import { FaqH, FinalH, HowItWorksH, VoiceWallH } from './SectionsH';
import styles from './h.module.css';
import palettes from './palettes-h.module.css';

const CHROME = SITE_CHROME['zh-Hans'];
const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
export type LandingData = ReturnType<typeof buildLandingPageData>;

/**
 * Style sample H, "流光与层次": soft light and shade over a pale paper (AuroraBackdrop, one state per stretch of
 * the page from top to bottom; three candidate palettes, PaletteSwitchH), frosted-glass sheets stacked at
 * different depths, and motion throughout — the title rising in character by character, cards tilting up out of
 * depth as they scroll in and leaning toward the mouse, a glow that follows the pointer, the nine scenes typed out
 * message by message, prices rolling in like an odometer. The server HTML is the finished page; with reduced
 * motion everything is simply there.
 * Copy and section order are the landing page's.
 */
export function SampleH({ data, siteName, membershipHref }: { data: LandingData; siteName: string; membershipHref: string }) {
  const previewSteps = data.flowSteps.slice(0, 3);
  return (
    <DepthStage className={cn(light.light, displayFont.variable, palettes.palette, styles.page)}>
      <AuroraBackdrop />
      <PaletteSwitchH />
      <nav aria-label="样稿切换" className={styles.sampleBar}>
        <span>不公开的风格样稿，文案为定稿原文</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'h' ? 'page' : undefined}>{id.toUpperCase()}</Link>
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
            <Link href={LOGIN_HREF} className={cn(styles.pill, styles.pillGlass, styles.headerLogin)}>{CHROME.login}</Link>
            <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillInk)}>{HERO.primaryCta}</Link>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section aria-labelledby="hero-title" className={styles.hero}>
          <div className={styles.heroText}>
            <h1 id="hero-title" className={styles.heroTitle}><SplitText text={HERO.title} mode="load" /></h1>
            <p className={styles.heroPromise}>{HERO.promise}</p>
            <div className={styles.heroActions}>
              <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillInk, styles.pillLarge, styles.pillGlow)}>
                {HERO.primaryCta}<ArrowRight size={17} aria-hidden="true" />
              </Link>
              <a href="#how-it-works" className={cn(styles.pill, styles.pillGlass, styles.pillLarge)}>
                {HERO.secondaryCta}<ArrowDown size={17} aria-hidden="true" />
              </a>
            </div>
            <p className={styles.heroNote}>{data.heroNote}</p>
          </div>

          {previewSteps.length > 0 ? (
            <div className={styles.stage} aria-hidden="true">
              <span className={styles.lens}><i /></span>
              {previewSteps.map((step, index) => (
                <div key={step.id} className={cn(styles.chipSlot, depthClass.parallax)}
                  style={{ '--speed': [0.5, 1.1, 0.8][index], '--slot': index } as CSSProperties}>
                  <div className={styles.chip}>
                    <span className={styles.chipIndex}>{index + 1}</span>
                    <span className={styles.chipText}><b>{step.title}</b><small>{step.demo}</small></span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className={cn(styles.heroDemo, depthClass.depth)}>
            <div className={styles.demoFrame}><LazyDemo /></div>
          </div>
        </section>

        <VoiceWallH notes={data.notes} />
        <HowItWorksH promise={data.promise} steps={data.flowSteps} reports={data.sampleReports} timeline={data.timeline} />
        <PriceH data={data} membershipHref={membershipHref} />
        <FaqH groups={data.faqGroups} />
        <FinalH showStack={data.showStack} founderSeats={data.founderSeats} note={data.finalNote} />
      </main>

      <footer className={styles.footer}>
        <nav aria-label="页脚">
          {CHROME.nav.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          <Link href={LOGIN_HREF}>{CHROME.login}</Link>
        </nav>
        <p>© 2026 Grayscale Luminary LLC</p>
      </footer>
    </DepthStage>
  );
}
