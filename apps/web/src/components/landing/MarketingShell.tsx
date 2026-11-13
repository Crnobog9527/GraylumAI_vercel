/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import { PublicShell } from '@/components/public-site/PublicShell';
import { getPublicSiteSettings } from '@/lib/public-site';

/**
 * The Simplified-Chinese marketing pages (pricing, contact, accessibility) on the public shell, all on the light tone (the
 * home page's look, Owner 2026-11-14 PUBLIC-SITE).
 */
export default async function MarketingShell({
  children,
  tone = 'light',
  mainClassName,
}: {
  children: ReactNode;
  tone?: 'light' | 'dark';
  mainClassName?: string;
}) {
  const { siteName, supportEmail } = await getPublicSiteSettings();

  return (
    <PublicShell locale="zh-Hans" siteName={siteName} supportEmail={supportEmail} tone={tone} mainClassName={mainClassName}>
      {children}
    </PublicShell>
  );
}
