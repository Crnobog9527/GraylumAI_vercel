/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import type { SiteLocale } from '@/lib/seo/site';
import { PublicShell } from './PublicShell';

/**
 * Header and footer for public content pages in one language: the public shell on the dark tone, because the content of
 * these pages (articles, FAQ, legal, founders) is still written for a dark canvas. A page moves to the light tone when its
 * own content is converted (DESIGN.md "Public-page layer"); until then the header and footer already are the shared ones.
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
    <PublicShell locale={locale} alternates={alternates} supportEmail={supportEmail} siteName={siteName} tone="dark">
      {children}
    </PublicShell>
  );
}
