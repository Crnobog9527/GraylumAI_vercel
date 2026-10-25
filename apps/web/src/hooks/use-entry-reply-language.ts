/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { usePathname } from 'next/navigation';
import { clearEntryLanguage, entryLanguageNotice, parseEntryNotice, pendingEntryLanguage, rememberEntryLanguage } from '@/lib/entry-language';
import { createClient } from '@/lib/supabase';
import { trpc } from '@/trpc/client';

/** Removes a one-time parameter from the address. State null, like the profile tabs: Next syncs its search params only for
 * a replace it did not make itself. */
function dropParam(name: string) {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(name)) return;
  params.delete(name);
  const rest = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
}

// One application at a time: a navigation while the first one runs must not apply (and announce) it twice.
let applying = false;

/** Keeps the language a public page's login or sign-up link carried, and applies it (see lib/entry-language.ts) once the user
 * is signed in, then says which language AI replies now use. Checked again on every navigation, because a password sign-in
 * moves to the app without reloading the page. */
export function useEntryReplyLanguage() {
  const utils = trpc.useUtils();
  const pathname = usePathname();
  useEffect(() => {
    // Public pages open the login page with lang=<their language>. A signed-in visitor is sent straight on: the server has
    // already saved the language (entry_notice=<from>.<to>, only to say so), or passes it on as entry_lang to apply here.
    const params = new URLSearchParams(window.location.search);
    if (pathname === '/login') rememberEntryLanguage(params.get('lang'));
    const saved = parseEntryNotice(params.get('entry_notice'));
    if (params.has('entry_notice')) {
      dropParam('entry_notice');
      if (saved) {
        clearEntryLanguage();
        void utils.user.getUserProfile.invalidate();
        const notice = entryLanguageNotice(saved);
        toast.success(notice.title, { description: notice.description });
        return;
      }
    }
    // Kept in the address until applied: a reload on the way between the two sites must not lose it.
    rememberEntryLanguage(params.get('entry_lang'));
    const language = pendingEntryLanguage();
    if (!language || applying) return;
    let live = true, mine = false;
    createClient().auth.getSession()
      .then(async ({ data }) => {
        if (!live || !data.session?.user || applying) return;
        applying = true; mine = true;
        const applied = await utils.client.user.applyEntryReplyLanguage.mutate({ language });
        clearEntryLanguage();
        dropParam('entry_lang');
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
