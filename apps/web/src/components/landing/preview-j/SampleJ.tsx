/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import dynamic from 'next/dynamic';
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import { LOGIN_HREF, SITE_CHROME } from '@/components/public-site/site-chrome';
import { HERO } from '@/lib/landing/landing-copy';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { HeroJ } from './HeroJ';
import { MotionJ } from './MotionJ';
import { TakeoverJ } from './TakeoverJ';
import { VoiceWallJ } from './VoiceWallJ';
import styles from './j.module.css';

const CHROME = SITE_CHROME['zh-Hans'];
/** The Owner's local edit mode: only in a development server; production builds drop the import entirely. */
const OwnerEditJ = process.env.NODE_ENV === 'development'
  ? dynamic(() => import('./OwnerEditJ').then(module => module.OwnerEditJ))
  : null;
const SAMPLES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;
export type LandingData = ReturnType<typeof buildLandingPageData>;

/**
 * Style sample J (Owner 2026-10-14, after sample H's v3): sample E's design baseline carrying sample H's content.
 * One full first screen (title, promise, button, the data-growth flywheel), the voice wall in sample F's form,
 * then "AI 教练怎么接手你的运营" as a scroll-locked story (positioning, the review panel, what you no longer do).
 * The remaining sections follow in later steps. The server HTML is the finished page.
 */
export function SampleJ({ data, siteName }: { data: LandingData; siteName: string; membershipHref: string }) {
  return (
    <MotionJ className={cn(light.light, styles.page)}>
      <nav aria-label="样稿切换" className={styles.sampleBar}>
        <span>不公开的风格样稿</span>
        {SAMPLES.map(id => (
          <Link key={id} href={`/landing/preview/${id}`} aria-current={id === 'j' ? 'page' : undefined}>{id.toUpperCase()}</Link>
        ))}
      </nav>
      <header className={styles.header}>
        <div className={cn(styles.wrap, styles.headerInner)}>
          <Link href="/landing" className={styles.brand}>
            <img src="/graylum-logo.svg" alt="" aria-hidden="true" width={28} height={28} />{siteName}
          </Link>
          <nav className={styles.nav} aria-label="主导航">
            {CHROME.nav.map(link => <Link key={link.href} href={link.href} className={styles.navLink}>{link.label}</Link>)}
            <Link href={LOGIN_HREF} className={styles.pillSmallLight}>{CHROME.login}</Link>
            <Link href={SIGNUP_CTA_HREF} className={styles.pillSmall}>{HERO.primaryCta}</Link>
          </nav>
        </div>
      </header>

      <main>
        <HeroJ />
        <VoiceWallJ notes={data.notes} />
        <TakeoverJ />
      </main>

      <footer className={styles.footer}>
        <div className={styles.wrap}>
          <nav aria-label="页脚">
            {CHROME.nav.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}
            <Link href={LOGIN_HREF}>{CHROME.login}</Link>
          </nav>
          <p>© 2026 Grayscale Luminary LLC</p>
        </div>
      </footer>
      {OwnerEditJ ? <OwnerEditJ /> : null}
    </MotionJ>
  );
}
