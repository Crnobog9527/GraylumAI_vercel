/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import { displayFont } from '@/components/landing/preview-d/display-font';
import { DepthStage } from '@/components/public-site/motion/DepthStage';
import { LOGIN_HREF, SITE_CHROME } from '@/components/public-site/site-chrome';
import { HERO, HERO_H } from '@/lib/landing/landing-copy';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { HeroH } from './HeroH';
import { AudienceH, WhyH } from './ScreensH';
import { PriceH } from './PriceH';
import { FaqH, FinalH, HowItWorksH, VoiceWallH } from './SectionsH';
import styles from './h.module.css';

const CHROME = SITE_CHROME['zh-Hans'];
const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
export type LandingData = ReturnType<typeof buildLandingPageData>;

/**
 * Style sample H, redesigned after the Owner's review of 2026-10-14 (buffer.com as the reference, option A): a clean
 * near-white page; a quiet first screen (title, promise, button, one large view of the real product), then one idea
 * per screen — who it is for (AudienceH), why not a general AI (WhyH) — and the rest of the landing page's sections.
 * The server HTML is the finished page; with reduced motion everything is simply there.
 * Copy and section order are the landing page's.
 */
export function SampleH({ data, siteName, membershipHref }: { data: LandingData; siteName: string; membershipHref: string }) {
  return (
    <DepthStage className={cn(light.light, displayFont.variable, styles.page)}>
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
        <HeroH />
        <AudienceH />
        <WhyH />

        <VoiceWallH notes={data.notes} />
        <HowItWorksH promise={data.promise} steps={data.flowSteps} reports={data.sampleReports} timeline={data.timeline} />
        <PriceH data={data} membershipHref={membershipHref} />
        <FaqH groups={data.faqGroups} />
        <FinalH showStack={data.showStack} founderSeats={data.founderSeats} note={HERO_H.ctaNote} />
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
