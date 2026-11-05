/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import { PublicShell } from '@/components/public-site/PublicShell';
import { getPublicSiteSettings } from '@/lib/public-site';

/**
 * The Simplified-Chinese marketing pages (pricing, contact, accessibility) on the public shell. `tone` defaults to dark
 * because contact and accessibility are still written for a dark canvas; pricing is on the light tone.
 */
export default async function MarketingShell({
  children,
  tone = 'dark',
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
