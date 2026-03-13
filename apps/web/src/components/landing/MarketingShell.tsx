/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import LandingHeader from '@/components/landing/LandingHeader';
import LandingFooter from '@/components/landing/LandingFooter';
import { getPublicSiteSettings } from '@/lib/public-site';

export default async function MarketingShell({
  children,
  mainClassName = 'pt-20 md:pt-24',
}: {
  children: ReactNode;
  mainClassName?: string;
}) {
  const { siteName, supportEmail } = await getPublicSiteSettings();

  return (
    <>
      <LandingHeader siteName={siteName} />
      <main className={mainClassName}>{children}</main>
      <LandingFooter siteName={siteName} supportEmail={supportEmail} />
    </>
  );
}
