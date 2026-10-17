/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { isEmailVerified } from '@/lib/auth';
import { clearFirstTouch, firstTouchForSignup } from '@/lib/analytics/attribution';
import { isFreshSignUp, reportSignUpIfNew } from '@/lib/analytics/events';
import { createClient } from '@/lib/supabase';
import { trpc } from '@/trpc/client';

/**
 * Right after sign-up (email verified, or the first Google sign-in, within 30 minutes) and only with live statistics
 * consent: GA `sign_up` once, and the stored first touch sent once to the account (ANALYTICS plan §3.1, §3.2).
 * Never on a sensitive page. Uses the plain client so a stale login never raises the app-wide notice.
 */
export function useSignupReporting(active: boolean) {
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!active) return;
    let live = true;
    createClient().auth.getSession()
      .then(async ({ data }) => {
        const user = data.session?.user;
        const verified = isEmailVerified(user);
        if (!live || !user || !isFreshSignUp(user, verified)) return;
        reportSignUpIfNew(user, verified);
        const attribution = firstTouchForSignup();
        if (!attribution) return;
        await utils.client.analytics.recordSignupAttribution.mutate({ attribution });
        clearFirstTouch();
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [active, utils]);
}
