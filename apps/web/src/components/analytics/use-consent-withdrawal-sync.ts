/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { clearFirstTouch } from '@/lib/analytics/attribution';
import { analyticsAllowed, type ConsentSnapshot } from '@/lib/analytics/consent';
import { createClient } from '@/lib/supabase';
import { trpc } from '@/trpc/client';

const SENT_KEY = 'graylum.analytics.withdrawal-sent';
// Growing waits, then every two minutes for as long as the page stays open; the browser coming back online retries at once.
const RETRY_MS = [2_000, 8_000, 30_000, 120_000];

/**
 * ANALYTICS §7 PR-3: when Termly says statistics are not allowed for a logged-in account, tell the server once per
 * account per browser session, so GA ids kept for its unpaid orders are dropped and older ones are never reported.
 * The notice is durable: it is retried with growing waits (then every two minutes) for as long as the page is
 * open, and at once when the browser comes back online; the "sent" marker is only set after the server confirmed,
 * and any page opened in a later session sends it again. The server also keeps these ids for the checkout's
 * payable window only (45 minutes), so a notice lost for good can matter only inside it. Uses the plain client so
 * a stale login never raises the app-wide re-login notice.
 */
export function useConsentWithdrawalSync(consent: ConsentSnapshot, enabled: boolean) {
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!enabled || !consent.ready) return;
    if (consent.analytics) {
      try { window.sessionStorage.removeItem(SENT_KEY); } catch { /* storage unavailable */ }
      return;
    }
    // No consent (refused or withdrawn): the stored first touch goes too (ANALYTICS §7 PR-3 acceptance).
    clearFirstTouch();
    let active = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const client = createClient();
    const sync = (attempt = 0): void => {
      client.auth.getSession()
        .then(async ({ data }) => {
          const userId = data.session?.user.id;
          if (!active || !userId) return;
          // The marker names the account it was sent for: another account in this tab still sends its own.
          try { if (window.sessionStorage.getItem(SENT_KEY) === userId) return; } catch { /* storage unavailable: send */ }
          await utils.client.analytics.withdrawConsent.mutate();
          // Consent may have come back while the request was in flight: then this notice no longer stands for the
          // current denial, so the marker must not outlive it (a later withdrawal has to notify again).
          if (!active || analyticsAllowed()) return;
          try { window.sessionStorage.setItem(SENT_KEY, userId); } catch { /* sent; may repeat next page */ }
        })
        .catch(() => {
          if (!active) return;
          const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
          const timer = setTimeout(() => { timers.delete(timer); sync(attempt + 1); }, wait);
          timers.add(timer);
        });
    };
    const retryNow = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); sync(); };
    sync();
    window.addEventListener('online', retryNow);
    // A different account signing in on this page is synchronised too.
    const { data: listener } = client.auth.onAuthStateChange(event => { if (event === 'SIGNED_IN') sync(); });
    return () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
      listener.subscription.unsubscribe();
      window.removeEventListener('online', retryNow);
    };
  }, [enabled, consent.ready, consent.analytics, utils]);
}
