/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { PUBLIC_PAGES } from '@/lib/seo/public-pages';
import { SITE_LOCALES, type SiteLocale } from '@/lib/seo/site';
import { LANGUAGE_NAMES, LOGIN_HREF, SIGNUP_HREF, SITE_CHROME } from './site-chrome';

const LINK_CLASS = 'text-sm text-[#9A9A9A] transition-colors hover:text-[#FFD700]';
const LOCALES: SiteLocale[] = ['zh-Hans', 'zh-TW'];

function FooterColumn({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  if (links.length === 0) {
    return null;
  }
  return (
    <div>
      <p className="mb-4 text-sm font-semibold text-white">{title}</p>
      <ul className="space-y-3">
        {links.map(link => (
          <li key={link.href}>
            <Link href={link.href} className={LINK_CLASS}>{link.label}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Header and footer for public content pages in one language, server-rendered without client JS. The
 * wrapper carries the page language until the /app move splits the root layout per language (SEO_GEO_SPEC 15).
 * `alternates` are this page in other languages; the language switch falls back to that language's home.
 */
export function SiteShell({
  locale,
  alternates = {},
  supportEmail,
  children,
}: {
  locale: SiteLocale;
  alternates?: Partial<Record<SiteLocale, string>>;
  supportEmail?: string | null;
  children: ReactNode;
}) {
  const chrome = SITE_CHROME[locale];
  const companyHrefs = new Set(chrome.company.map(link => link.href));
  const pageLinks = PUBLIC_PAGES
    .filter(page => page.locale === locale && page.footerLabel && !companyHrefs.has(page.path))
    .map(page => ({ label: page.footerLabel!, href: page.path }));
  const languageLinks = LOCALES.map(key => ({
    label: LANGUAGE_NAMES[key],
    href: key === locale ? '' : alternates[key] ?? SITE_CHROME[key].home,
  })).filter(link => link.href);

  return (
    <div lang={SITE_LOCALES[locale].htmlLang} className="min-h-screen bg-[#0A0A0A] text-white">
      <header className="border-b border-[#262626]">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link href={chrome.home} className="flex items-center gap-2">
            <img src="/graylum-logo.svg" alt="" aria-hidden="true" width={32} height={32} className="h-8 w-8 rounded-[10px]" />
            <span className="text-lg font-bold">Graylum</span>
          </Link>
          <nav className="flex items-center gap-4 sm:gap-6">
            {chrome.nav.map(link => (
              <Link key={link.href} href={link.href} className="hidden text-sm text-[#B0B0B0] hover:text-white sm:inline">
                {link.label}
              </Link>
            ))}
            <Link href={LOGIN_HREF} className="text-sm text-[#B0B0B0] hover:text-white">{chrome.login}</Link>
            <Link
              href={SIGNUP_HREF}
              className="rounded-lg bg-[#FFD700] px-4 py-2 text-sm font-semibold text-[#0A0A0A] hover:bg-[#FFE34D]"
            >
              {chrome.signup}
            </Link>
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="border-t border-[#262626]">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
          <FooterColumn title={chrome.pagesTitle} links={pageLinks} />
          <FooterColumn title={chrome.companyTitle} links={chrome.company} />
          <FooterColumn title={chrome.legalTitle} links={chrome.legal} />
          <FooterColumn title={chrome.languageTitle} links={languageLinks} />
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-10 text-xs text-[#6F6F6F] sm:px-6 lg:px-8">
          <p>© 2026 Grayscale Luminary LLC · {chrome.rights}</p>
          {supportEmail ? (
            <p className="mt-2">
              <a href={`mailto:${supportEmail}`} className="hover:text-[#FFD700]">{supportEmail}</a>
            </p>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
