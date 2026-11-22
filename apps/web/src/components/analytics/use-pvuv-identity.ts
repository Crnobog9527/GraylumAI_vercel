/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { forgetPvuvUser, identifyPvuv } from '@/lib/analytics/pvuv';
import { createClient } from '@/lib/supabase';

/**
 * ANALYTICS-PVUV: tell pvuv.ai which account this browser belongs to, by the account's opaque id and never the email, so
 * the server's sign-up and purchase reports join the visitor's journey. Runs only with live statistics consent; the call is
 * queued until the script is on the page and is ignored on pages the script is not loaded for. Uses the plain Supabase client
 * so a stale login never raises the app-wide re-login notice.
 */
export function usePvuvIdentity(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const client = createClient();
    let live = true;
    client.auth.getSession()
      .then(({ data }) => { if (live) identifyPvuv(data.session?.user.id); })
      .catch(() => undefined);
    const { data: listener } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') forgetPvuvUser();
      else identifyPvuv(session?.user.id);
    });
    return () => { live = false; listener.subscription.unsubscribe(); };
  }, [active]);
}
