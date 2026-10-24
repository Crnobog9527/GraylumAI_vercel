/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { clearEntryLanguage, pendingEntryLanguage } from '@/lib/entry-language';
import { createClient } from '@/lib/supabase';
import { trpc } from '@/trpc/client';

/** Applies a pending sign-up entry language (see lib/entry-language.ts) once the user is signed in. Checked again on
 * every navigation, because a password sign-in moves to the app without reloading the page. */
export function useEntryReplyLanguage() {
  const utils = trpc.useUtils();
  const pathname = usePathname();
  useEffect(() => {
    const language = pendingEntryLanguage();
    if (!language) return;
    let live = true;
    createClient().auth.getSession()
      .then(async ({ data }) => {
        if (!live || !data.session?.user) return;
        await utils.client.user.applyEntryReplyLanguage.mutate({ language });
        clearEntryLanguage();
        await utils.user.getUserProfile.invalidate();
      })
      // Kept for the next page: a failed attempt is retried there, and the server never overrides a choice.
      .catch(() => undefined);
    return () => { live = false; };
  }, [utils, pathname]);
}

/** Mounted once in the root document. */
export function EntryReplyLanguage() {
  useEntryReplyLanguage();
  return null;
}
