/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import type { ConsentSnapshot } from '@/lib/analytics/consent';
import { createClient } from '@/lib/supabase';
import { trpc } from '@/trpc/client';

const SENT_KEY = 'graylum.analytics.withdrawal-sent';

/**
 * ANALYTICS §7 PR-3: when Termly says statistics are not allowed for a logged-in account, tell the server once per
 * account per browser session, so GA ids kept for its unpaid orders are dropped and older ones are never reported. A lost
 * request is sent again on the next page load (the marker is only set after success) and in every new session.
 * Uses the plain client so a stale login never raises the app-wide re-login notice.
 */
export function useConsentWithdrawalSync(consent: ConsentSnapshot, enabled: boolean) {
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!enabled || !consent.ready) return;
    if (consent.analytics) {
      try { window.sessionStorage.removeItem(SENT_KEY); } catch { /* storage unavailable */ }
      return;
    }
    let active = true;
    const client = createClient();
    const sync = () => client.auth.getSession()
      .then(async ({ data }) => {
        const userId = data.session?.user.id;
        if (!active || !userId) return;
        // The marker names the account it was sent for: another account in this tab still sends its own.
        try { if (window.sessionStorage.getItem(SENT_KEY) === userId) return; } catch { /* storage unavailable: send */ }
        await utils.client.analytics.withdrawConsent.mutate();
        try { window.sessionStorage.setItem(SENT_KEY, userId); } catch { /* sent; may repeat next page */ }
      })
      .catch(() => undefined);
    void sync();
    // A different account signing in on this page is synchronised too.
    const { data: listener } = client.auth.onAuthStateChange(event => { if (event === 'SIGNED_IN') void sync(); });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, [enabled, consent.ready, consent.analytics, utils]);
}
