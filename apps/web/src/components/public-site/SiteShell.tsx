/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import type { SiteLocale } from '@/lib/seo/site';
import { PublicShell } from './PublicShell';

/**
 * Header and footer for public content pages in one language (articles, FAQ, legal, founders): the public shell's light
 * tone, the home page's "晨光" look (Owner 2026-11-14, PUBLIC-SITE). Their reading column is article.module.css.
 */
export function SiteShell({
  locale,
  alternates,
  supportEmail,
  siteName,
  children,
}: {
  locale: SiteLocale;
  alternates?: Partial<Record<SiteLocale, string>>;
  supportEmail?: string | null;
  siteName?: string;
  children: ReactNode;
}) {
  return (
    <PublicShell locale={locale} alternates={alternates} supportEmail={supportEmail} siteName={siteName} tone="light">
      {children}
    </PublicShell>
  );
}
