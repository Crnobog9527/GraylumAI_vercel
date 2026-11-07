/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { ANALYTICS_CONFIG, gtagScriptUrl } from '@/lib/analytics/config';
import { consentSnapshot, serverConsentSnapshot, subscribeConsent } from '@/lib/analytics/consent';
import { captureFirstTouch } from '@/lib/analytics/attribution';
import { enterPage, syncGa } from '@/lib/analytics/ga';
import { isSensitivePath } from '@/lib/analytics/routes';
import { cleanVercelEvent } from '@/lib/analytics/vercel';
import type { SiteLocale } from '@/lib/seo/site';
import { ConsentBar } from './ConsentBar';
import { useConsentWithdrawalSync } from './use-consent-withdrawal-sync';
import { useSignupReporting } from './use-signup-reporting';

/**
 * Consent bar and statistics for every page (ANALYTICS plan §3, ANALYTICS-CONSENT). Our own consent module decides from
 * the region class and the visitor's choice; GA (once configured), the stored first touch and Speed Insights follow it.
 * Vercel Web Analytics is cookieless and reports every visitor. Rendered from the root layout as a client component that
 * reads nothing on the server, so public pages stay static; the bar never holds up the first paint.
 */
export function SiteAnalytics({ onVercel, locale }: { onVercel: boolean; locale: SiteLocale }) {
  const { gaMeasurementId, vercelCategory } = ANALYTICS_CONFIG;
  const pathname = usePathname();
  const consent = useSyncExternalStore(subscribeConsent, consentSnapshot, serverConsentSnapshot);
  const previous = useRef<string | null>(null);
  useConsentWithdrawalSync(consent, true);

  // A new address: record it (cleaned) and report it if consent allows.
  useEffect(() => {
    enterPage(window.location.href, previous.current);
    if (previous.current === null) captureFirstTouch(window.location.href, document.referrer);
    previous.current = window.location.href;
    syncGa(gaMeasurementId);
  }, [pathname, gaMeasurementId]);

  // Consent given, refused or withdrawn on this page.
  useEffect(() => {
    syncGa(gaMeasurementId);
    // Consent given on this page: its address is the first touch we may keep.
    if (consent.analytics) captureFirstTouch(window.location.href, document.referrer);
  }, [consent.analytics, gaMeasurementId]);

  const reportable = !isSensitivePath(pathname ?? '/');
  // sign_up and the first source of an account created moments ago, once, after consent.
  useSignupReporting(consent.analytics && reportable);

  // Injected scripts outlive this component, so cleanVercelEvent re-checks consent and the page on every event.
  const speedInsightsOn = onVercel && reportable && (vercelCategory === 'essential' || consent.analytics);
  return (
    <>
      {/* gtag.js is added only with live consent; once added, ga.ts pauses it on withdrawal (ga-disable). */}
      {gaMeasurementId && consent.analytics ? (
        <Script id="ga4-gtag" src={gtagScriptUrl(gaMeasurementId)} strategy="afterInteractive" />
      ) : null}
      {onVercel && reportable ? (
        <Analytics beforeSend={event => cleanVercelEvent(event, 'web-analytics', vercelCategory)} />
      ) : null}
      {speedInsightsOn ? <SpeedInsights beforeSend={event => cleanVercelEvent(event, 'speed-insights', vercelCategory)} /> : null}
      <ConsentBar consent={consent} locale={locale} />
    </>
  );
}
