/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { isEmailVerified } from '@/lib/auth';
import { ANALYTICS_CONFIG, gtagScriptUrl, termlyScriptUrl } from '@/lib/analytics/config';
import { attachTermly, consentSnapshot, serverConsentSnapshot, subscribeConsent } from '@/lib/analytics/consent';
import { reportSignUpIfNew } from '@/lib/analytics/events';
import { enterPage, syncGa } from '@/lib/analytics/ga';
import { isSensitivePath } from '@/lib/analytics/routes';
import { cleanVercelEvent } from '@/lib/analytics/vercel';
import { createClient } from '@/lib/supabase';
import { useConsentWithdrawalSync } from './use-consent-withdrawal-sync';

/**
 * Consent banner and statistics for every page (ANALYTICS plan §3). Termly loads asynchronously and never
 * holds up the first paint (plan O1 option A); GA, Vercel Web Analytics and Speed Insights follow Termly's
 * live consent. Without a Termly website ID nothing loads at all. Rendered from the root layout as a client
 * component that reads nothing on the server, so public pages stay static.
 */
export function SiteAnalytics({ onVercel }: { onVercel: boolean }) {
  const { termlyWebsiteUuid, gaMeasurementId, vercelCategory } = ANALYTICS_CONFIG;
  const pathname = usePathname();
  const consent = useSyncExternalStore(subscribeConsent, consentSnapshot, serverConsentSnapshot);
  const previous = useRef<string | null>(null);
  useConsentWithdrawalSync(consent, Boolean(termlyWebsiteUuid));

  // A new address: record it (cleaned) and report it if consent allows.
  useEffect(() => {
    if (!termlyWebsiteUuid) return;
    enterPage(window.location.href, previous.current);
    previous.current = window.location.href;
    syncGa(gaMeasurementId);
  }, [pathname, termlyWebsiteUuid, gaMeasurementId]);

  // Consent given, refused or withdrawn on this page.
  useEffect(() => {
    if (termlyWebsiteUuid) syncGa(gaMeasurementId);
  }, [consent, termlyWebsiteUuid, gaMeasurementId]);

  // sign_up for an account created moments ago (email verified or Google), once, after consent.
  useEffect(() => {
    if (!termlyWebsiteUuid || !gaMeasurementId || !consent.analytics || isSensitivePath(pathname ?? '/')) return;
    let active = true;
    createClient().auth.getSession()
      .then(({ data }) => { if (active) reportSignUpIfNew(data.session?.user, isEmailVerified(data.session?.user)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [pathname, consent.analytics, termlyWebsiteUuid, gaMeasurementId]);

  if (!termlyWebsiteUuid) return null;
  // Injected scripts outlive this component, so cleanVercelEvent re-checks consent and the page on every event.
  const vercelOn = onVercel && (vercelCategory === 'essential' || consent.analytics) && !isSensitivePath(pathname ?? '/');
  return (
    <>
      <Script id="termly-consent" src={termlyScriptUrl(termlyWebsiteUuid)} strategy="afterInteractive" onLoad={attachTermly} />
      {/* Termly manual classification (plan O1 option A): inert until Termly releases it for analytics consent. */}
      {gaMeasurementId ? <script type="text/plain" data-categories="analytics" defer src={gtagScriptUrl(gaMeasurementId)} /> : null}
      {vercelOn ? (
        <>
          <Analytics beforeSend={event => cleanVercelEvent(event, vercelCategory)} />
          <SpeedInsights beforeSend={event => cleanVercelEvent(event, vercelCategory)} />
        </>
      ) : null}
    </>
  );
}
