/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { ConsentPreferenceLinks } from '@/components/analytics/ConsentPreferenceLinks';
import light from '@/components/design/light-tokens.module.css';
import { BackdropJ } from '@/components/landing/preview-j/BackdropJ';
import { SiteFooterJ } from '@/components/landing/preview-j/SiteFooterJ';
import { SiteHeaderJ } from '@/components/landing/preview-j/SiteHeaderJ';
import page from '@/components/landing/preview-j/j.module.css';
import dawn from '@/components/landing/preview-l/dawn-l.module.css';
import { HERO } from '@/lib/landing/landing-copy';
import { J_NAV } from '@/lib/landing/landing-copy-j-chrome';
import { PUBLIC_PAGES } from '@/lib/seo/public-pages';
import type { SiteLocale } from '@/lib/seo/site';
import { cn } from '@/lib/utils';
import { LANGUAGE_NAMES, LOGIN_HREFS, SIGNUP_HREFS, SITE_CHROME, visibleHref } from './site-chrome';
import styles from './public-shell.module.css';

const LOCALES: SiteLocale[] = ['zh-Hans', 'zh-TW'];
const MENU_LABEL: Record<SiteLocale, string> = { 'zh-Hans': J_NAV.menu, 'zh-TW': '選單' };
// The MiSans licence notice is no longer in the footer (Owner 2026-11-14, PUBLIC-SITE: "挪到相关的条款里面去"): it is on the
// terms page, under the document (LegalDocumentPage, FONT_LICENCE_NOTICE).

function FooterColumn({ title, links, extra }: { title: string; links: { label: string; href: string }[]; extra?: ReactNode }) {
  if (links.length === 0) {
    return null;
  }
  return (
    <div className={styles.column}>
      <p>{title}</p>
      <ul>
        {links.map(link => (
          <li key={link.href}>
            <Link href={link.href}>{link.label}</Link>
          </li>
        ))}
        {extra}
      </ul>
    </div>
  );
}

/**
 * Header, footer and canvas of the public pages in one language (DESIGN.md "Public-page layer"), server-rendered without
 * client JS (the mobile menu is a <details>); the page language is set on the document by that language's root layout
 * (SEO_GEO_SPEC 15). `alternates` are this page in other languages; the language switch falls back to that language's home.
 *
 * `tone="light"` is the public layer's own canvas, in the home page's "晨光" look (Owner 2026-11-14, PUBLIC-SITE: every public
 * page matches the home page, its background motion included): the home page's `.dawn` values for the header and the pills,
 * and its backdrop (BackdropJ, the one client island here), whose light follows the `data-zone` sections of the page. The
 * page's first light is `hero`; the footer is `final`. On the Simplified pages the light tone also takes the home page's own
 * header and footer (SiteHeaderJ, SiteFooterJ, as the production home page shows them), so the chrome is the same one on
 * every page; the zh-TW pages keep this shell's header and footer, with their own links. `tone="dark"` is transitional: pages whose content is still written
 * for a dark canvas keep it, with the same header and footer structure, until their content moves to the light layer.
 */
export function PublicShell({
  locale,
  alternates = {},
  supportEmail,
  siteName = 'Graylum',
  tone = 'light',
  mainClassName,
  children,
}: {
  locale: SiteLocale;
  alternates?: Partial<Record<SiteLocale, string>>;
  supportEmail?: string | null;
  // Platform name from admin settings (`site_name`); pages that do not read settings keep the brand default.
  siteName?: string;
  tone?: 'light' | 'dark';
  mainClassName?: string;
  children: ReactNode;
}) {
  const chrome = SITE_CHROME[locale];
  const homeChrome = tone === 'light' && locale === 'zh-Hans';
  const companyHrefs = new Set(chrome.company.map(link => link.href));
  const pageLinks = PUBLIC_PAGES
    .filter(page => page.locale === locale && page.footerLabel && !companyHrefs.has(page.path))
    .map(page => ({ label: page.footerLabel!, href: page.path }));
  const languageLinks = LOCALES.map(key => ({
    label: LANGUAGE_NAMES[key],
    href: key === locale ? '' : visibleHref(alternates[key] ?? SITE_CHROME[key].home),
  })).filter(link => link.href);

  const header = (
    <header className={styles.header}>
      <div className={cn(styles.wrap, styles.bar)}>
        <Link href={chrome.home} className={styles.brand}>
          <img src="/graylum-logo.svg" alt="" aria-hidden="true" width={28} height={28} />
          <span>{siteName}</span>
        </Link>
        <nav className={styles.desktop}>
          {chrome.nav.map(link => <Link key={link.href} href={link.href} className={styles.item}>{link.label}</Link>)}
        </nav>
        <div className={styles.end}>
          {/* No prefetch: following these links is what applies the page language (CHAT-LANGUAGE), so each click reaches the server. */}
          <Link href={LOGIN_HREFS[locale]} prefetch={false} className={cn(styles.pill, styles.pillLight, styles.desktopOnly)}>{chrome.login}</Link>
          <Link href={SIGNUP_HREFS[locale]} prefetch={false} className={cn(styles.pill, styles.pillDark)}>{chrome.signup}</Link>
          <details className={styles.menu}>
            <summary className={styles.burger} aria-label={MENU_LABEL[locale]}>
              <Menu size={20} aria-hidden="true" className={styles.burgerOpen} />
              <X size={20} aria-hidden="true" className={styles.burgerClose} />
            </summary>
            <div className={styles.drawer}>
              <nav className={styles.wrap} aria-label={chrome.mobileNavLabel}>
                {chrome.nav.map(link => <Link key={link.href} href={link.href}>{link.label}</Link>)}
                <Link href={LOGIN_HREFS[locale]} prefetch={false}>{chrome.login}</Link>
              </nav>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
  const footer = (
    <footer className={styles.footer} data-zone={tone === 'light' ? 'final' : undefined}>
      <div className={styles.wrap}>
        <div className={styles.columns}>
          <FooterColumn title={chrome.pagesTitle} links={pageLinks} />
          <FooterColumn title={chrome.companyTitle} links={chrome.company} />
          <FooterColumn title={chrome.legalTitle} links={chrome.legal}
            extra={<ConsentPreferenceLinks locale={locale} className={styles.consent} />} />
          <FooterColumn title={chrome.languageTitle} links={languageLinks} />
        </div>
        <div className={styles.base}>
          <p>© 2026 Grayscale Luminary LLC · {chrome.rights}</p>
          {supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : null}
        </div>
      </div>
    </footer>
  );

  return (
    <div className={cn(tone === 'light' && [light.light, dawn.dawn, page.page], styles.root)} data-tone={tone}
      data-zone={tone === 'light' ? 'hero' : undefined}>
      {tone === 'light' ? <BackdropJ track /> : null}
      {homeChrome ? <SiteHeaderJ siteName={siteName} cta={HERO.primaryCta} onlyBuilt /> : header}
      <main className={mainClassName}>{children}</main>
      {homeChrome
        ? <div className={styles.footerZone} data-zone="final"><SiteFooterJ onlyBuilt supportEmail={supportEmail} /></div>
        : footer}
    </div>
  );
}
