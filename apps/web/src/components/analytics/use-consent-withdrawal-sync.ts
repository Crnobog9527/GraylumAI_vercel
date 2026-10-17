/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { clearFirstTouch } from '@/lib/analytics/attribution';
import type { ConsentSnapshot } from '@/lib/analytics/consent';
import { createClient } from '@/lib/supabase';
import { trpc } from '@/trpc/client';

const SENT_KEY = 'graylum.analytics.withdrawal-sent';

/**
 * ANALYTICS §7 PR-3: when Termly says statistics are not allowed, drop the stored first touch and, for a logged-in
 * account, tell the server once per
 * browser session, so GA ids kept for its unpaid orders are dropped and older ones are never reported. A lost
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
    // No consent (refused or withdrawn): the stored first touch goes too (ANALYTICS §7 PR-3 acceptance).
    clearFirstTouch();
    try { if (window.sessionStorage.getItem(SENT_KEY) === '1') return; } catch { /* storage unavailable: send */ }
    let active = true;
    createClient().auth.getSession()
      .then(async ({ data }) => {
        if (!active || !data.session) return;
        await utils.client.analytics.withdrawConsent.mutate();
        try { window.sessionStorage.setItem(SENT_KEY, '1'); } catch { /* sent; may repeat next page */ }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [enabled, consent.ready, consent.analytics, utils]);
}
