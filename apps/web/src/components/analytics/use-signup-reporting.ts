/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { isEmailVerified } from '@/lib/auth';
import { clearFirstTouch, firstTouchForSignup } from '@/lib/analytics/attribution';
import { ANALYTICS_CONFIG } from '@/lib/analytics/config';
import { isFreshSignUp, reportSignUpIfNew, signUpMethod } from '@/lib/analytics/events';
import { createClient } from '@/lib/supabase';
import { trpc } from '@/trpc/client';

/**
 * Right after sign-up (email verified, or the first Google sign-in, within 30 minutes) and only with live statistics
 * consent: GA `sign_up` once, and the stored first touch sent once to the account (ANALYTICS plan §3.1, §3.2).
 * Never on a sensitive page. Uses the plain client so a stale login never raises the app-wide notice.
 * ANALYTICS-PVUV: the server `signup` event also goes out without statistics consent.
 */
const signupSent = new Set<string>();

export function useSignupReporting(active: boolean, reportable = active) {
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!reportable) return;
    let live = true;
    createClient().auth.getSession()
      .then(async ({ data }) => {
        const user = data.session?.user;
        const verified = isEmailVerified(user);
        if (!live || !user || !isFreshSignUp(user, verified)) return;
        // ANALYTICS-PVUV: the server's `signup` event does not depend on statistics consent (it carries the account id only;
        // pvuv's own visitor cookie rides along when consent made it exist). Once per account per page load; pvuv dedupes the rest.
        if (ANALYTICS_CONFIG.pvuvSite && !signupSent.has(user.id)) {
          signupSent.add(user.id);
          utils.client.analytics.reportSignup.mutate({ method: signUpMethod(user) }).catch(() => signupSent.delete(user.id));
        }
        if (!active) return;
        reportSignUpIfNew(user, verified);
        const attribution = firstTouchForSignup();
        if (!attribution) return;
        await utils.client.analytics.recordSignupAttribution.mutate({ attribution });
        clearFirstTouch();
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [active, reportable, utils]);
}
