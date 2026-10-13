/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import light from '@/components/design/light-tokens.module.css';
import { LOGIN_HREF, SITE_CHROME } from '@/components/public-site/site-chrome';
import { HERO } from '@/lib/landing/landing-copy';
import type { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { cn } from '@/lib/utils';
import { EFaq, EFinal, EPrice } from './ESectionsBottom';
import { EHero, EHowItWorks, EVoiceWall } from './ESectionsTop';
import styles from './e.module.css';

const CHROME = SITE_CHROME['zh-Hans'];
type Data = ReturnType<typeof buildLandingPageData>;

/**
 * Style sample E (frontend-design, after ploy.ai's visual language): the landing page's six modules in their fixed
 * order with the final copy unchanged — hero, voice wall, how the coach works (with the real conversation demo),
 * price, FAQ, final action — on the light foundation. Not public; removed once the Owner picks a style.
 */
export function PreviewE({ data, siteName, membershipHref }: { data: Data; siteName: string; membershipHref: string }) {
  return (
    <div className={cn(light.light, styles.page)}>
      <p className={styles.sampleBar}>不公开的风格样稿 E（frontend-design，参考 ploy.ai 的视觉语言），文案为定稿原文</p>
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
        <EHero note={data.heroNote} />
        <EVoiceWall notes={data.notes} />
        <EHowItWorks promise={data.promise} steps={data.flowSteps} reports={data.sampleReports} timeline={data.timeline} />
        <EPrice pricing={data.pricing} rows={data.compareRows} risk={data.risk} showResult={data.showResult}
          founderSeats={data.founderSeats} membershipHref={membershipHref} />
        <EFaq groups={data.faqGroups} />
        <EFinal showStack={data.showStack} founderSeats={data.founderSeats} note={data.finalNote} />
      </main>

      <footer className={styles.footer}>
        <div className={cn(styles.wrap, styles.footerGrid)}>
          <p className={styles.footerBrand}>{siteName}</p>
          <div>
            <p className={styles.footerTitle}>{CHROME.companyTitle}</p>
            <ul>{CHROME.company.map(link => <li key={link.href}><Link href={link.href}>{link.label}</Link></li>)}</ul>
          </div>
          <div>
            <p className={styles.footerTitle}>{CHROME.legalTitle}</p>
            <ul>{CHROME.legal.map(link => <li key={link.href}><Link href={link.href}>{link.label}</Link></li>)}</ul>
          </div>
        </div>
        <div className={styles.wrap}><p className={styles.copyright}>© 2026 Grayscale Luminary LLC · {CHROME.rights}</p></div>
      </footer>
    </div>
  );
}
