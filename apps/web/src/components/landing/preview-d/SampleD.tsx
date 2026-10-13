/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowDown, ArrowRight } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { LazyDemo } from '@/components/landing/demo/LazyDemo';
import { LOGIN_HREF, SITE_CHROME } from '@/components/public-site/site-chrome';
import { HERO } from '@/lib/landing/landing-copy';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { displayFont } from './display-font';
import { PriceD } from './PriceD';
import { FaqD, FinalD, HowItWorksD, VoiceWallD } from './SectionsD';
import styles from './d.module.css';

const CHROME = SITE_CHROME['zh-Hans'];
const SAMPLES = ['a', 'b', 'c', 'd'] as const;
export type LandingData = ReturnType<typeof buildLandingPageData>;

/**
 * Style sample D: the final landing copy and its six sections in their fixed order (hero, sticky notes,
 * how the coach works, price, FAQ, final action), dressed in ploy.ai's design language: giant heavy display
 * type, inset rounded panels on a grey canvas, black pill actions. The demo window is the #893 demo
 * (the real conversation components), unchanged; only the frame around it is this sample's.
 */
export function SampleD({ data, siteName, membershipHref }: { data: LandingData; siteName: string; membershipHref: string }) {
  return (
    <div className={cn(light.light, displayFont.variable, styles.page)}>
      <nav aria-label="样稿切换" className={styles.sampleBar}>
        <span>不公开的风格样稿，文案为定稿原文</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'd' ? 'page' : undefined}>样稿 {id.toUpperCase()}</Link>
        ))}
        <span className={styles.sampleNote}>D · 用 Impeccable 按 ploy.ai 的设计语言做：超大粗体标题、圆角大画板、黑色胶囊按钮。</span>
      </nav>

      <header className={styles.header}>
        <div className={styles.headerPill}>
          <Link href="/landing" className={styles.brand}>
            <img src="/graylum-logo.svg" alt="" aria-hidden="true" width={26} height={26} />{siteName}
          </Link>
          <nav className={styles.nav} aria-label="主导航">
            {CHROME.nav.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}
          </nav>
        </div>
        <div className={styles.headerActions}>
          <Link href={LOGIN_HREF} className={cn(styles.pill, styles.pillLight)}>{CHROME.login}</Link>
          <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillDark, styles.headerCta)}>{HERO.primaryCta}</Link>
        </div>
      </header>

      <main>
        <section aria-labelledby="hero-title" className={styles.hero}>
          <div className={styles.heroStage}>
            <h1 id="hero-title" className={styles.heroTitle}>{HERO.title}</h1>
            <p className={styles.heroPromise}>{HERO.promise}</p>
            <div className={styles.heroActions}>
              <Link href={SIGNUP_CTA_HREF} className={cn(styles.pill, styles.pillLight, styles.pillLarge)}>
                {HERO.primaryCta}<ArrowRight size={18} aria-hidden="true" />
              </Link>
              <a href="#how-it-works" className={cn(styles.pill, styles.pillGhost, styles.pillLarge)}>
                {HERO.secondaryCta}<ArrowDown size={18} aria-hidden="true" />
              </a>
            </div>
            <p className={styles.heroNote}>{data.heroNote}</p>
          </div>
          <div className={styles.heroDemo}>
            <LazyDemo />
          </div>
        </section>

        <VoiceWallD notes={data.notes} />
        <HowItWorksD promise={data.promise} steps={data.flowSteps} reports={data.sampleReports} timeline={data.timeline} />
        <PriceD data={data} membershipHref={membershipHref} />
        <FaqD groups={data.faqGroups} />
        <FinalD showStack={data.showStack} founderSeats={data.founderSeats} note={data.finalNote} />
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
