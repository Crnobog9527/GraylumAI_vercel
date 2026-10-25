/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { usePathname } from 'next/navigation';
import { clearEntryLanguage, entryLanguageNotice, pendingEntryLanguage, rememberEntryLanguage } from '@/lib/entry-language';
import { createClient } from '@/lib/supabase';
import { trpc } from '@/trpc/client';

/** Keeps the language a public page's login or sign-up link carried, and applies it (see lib/entry-language.ts) once the user
 * is signed in, then says which language AI replies now use. Checked again on every navigation, because a password sign-in
 * moves to the app without reloading the page. */
// One application at a time: a navigation while the first one runs must not apply (and announce) it twice.
let applying = false;

export function useEntryReplyLanguage() {
  const utils = trpc.useUtils();
  const pathname = usePathname();
  useEffect(() => {
    // Public pages open the login page with lang=<their language>; without it the visitor did not come from one.
    if (pathname === '/login') rememberEntryLanguage(new URLSearchParams(window.location.search).get('lang'));
    const language = pendingEntryLanguage();
    if (!language || applying) return;
    let live = true, mine = false;
    createClient().auth.getSession()
      .then(async ({ data }) => {
        if (!live || !data.session?.user || applying) return;
        applying = true; mine = true;
        const applied = await utils.client.user.applyEntryReplyLanguage.mutate({ language });
        clearEntryLanguage();
        await utils.user.getUserProfile.invalidate();
        const notice = entryLanguageNotice(applied);
        toast.success(notice.title, { description: notice.description });
      })
      // Kept for the next page: a failed attempt is retried there while the hint is still fresh.
      .catch(() => undefined)
      .finally(() => { if (mine) applying = false; });
    return () => { live = false; };
  }, [utils, pathname]);
}

/** Mounted once in the root document. */
export function EntryReplyLanguage() {
  useEntryReplyLanguage();
  return null;
}
