'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, httpLink, splitLink } from '@trpc/client';
import React, { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { createClient } from '@/lib/supabase';
import { isUnauthorizedError } from '@/lib/auth-recovery';
import { useUnauthorizedRecovery } from '@/hooks/use-unauthorized-recovery';
import { UnauthorizedNotice } from '@/components/auth/UnauthorizedNotice';
import { createSessionRefresher } from '@/lib/session-refresh';
import { sessionRefreshLink } from '@/trpc/session-refresh-link';
import { trpcLinkKind } from '@/trpc/link-routing';
import { TRPC_MAX_BATCH_CALLS } from '@/lib/trpcBatchLimit';
import { toast } from 'sonner';
import { isProfileArchivedError, PROFILE_ARCHIVE_TEXT } from '@/components/opc/profile-archive/profile-archive';
import { PROFILE_BUSINESSES_KEY } from '@/components/opc/profile-archive/profile-archive-api';
import { mutationAffectsRuntimeChoices } from '@/lib/runtime-choices';
import { clearPersistedCache, persistQueryCache, restoreQueryCache } from '@/lib/persisted-cache';
import { readSessionUserIdSync } from '@/lib/session-user';

export default function Provider({ children }: { children: React.ReactNode }) {
  // The query client is created once; it reaches the latest recovery handler through this ref.
  const onUnauthorizedRef = useRef<() => void>(() => undefined);
  const [queryClient] = useState(() => {
    const onError = (error: unknown) => {
      if (isUnauthorizedError(error)) onUnauthorizedRef.current();
      // PAYWALL: a write on a profile archived elsewhere says why once, and the re-read turns its pages read-only.
      if (isProfileArchivedError(error)) {
        toast.info(PROFILE_ARCHIVE_TEXT.archivedRefusal, { id: 'profile-archived' });
        void client.invalidateQueries({ queryKey: PROFILE_BUSINESSES_KEY });
      }
    };
    const client = new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({
        onError,
        // DB-100: runtime.choices is cached for minutes; an admin change must show up at once in this browser.
        onSuccess: (_data, _variables, _context, mutation) => {
          if (mutationAffectsRuntimeChoices(mutation.options.mutationKey)) {
            void client.invalidateQueries({ queryKey: [['runtime', 'choices']] });
          }
        },
      }),
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          gcTime: 5 * 60_000,
          refetchOnWindowFocus: false,
          // Retrying cannot fix a missing login; recovery handles 401 instead.
          retry: (failureCount, error) => !isUnauthorizedError(error) && failureCount < 1,
        },
      },
    });
    return client;
  });
  const [supabase] = useState(() => createClient());
  // Saved page data (lib/persisted-cache.ts): put back before the first paint, so a reload shows the last content at once while the same
  // reads run again behind it and replace it. Saved again, a moment after any read changes, and when the page is hidden.
  const knownUser = useRef<string | null>(null);
  // Bumped when the user changes: the pages (and what they hold in state) mount again, so nothing of the last user stays on screen.
  const [epoch, setEpoch] = useState(0);
  useLayoutEffect(() => {
    knownUser.current = readSessionUserIdSync();
    restoreQueryCache(queryClient, knownUser.current);
  }, [queryClient]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => { timer = undefined; persistQueryCache(queryClient, readSessionUserIdSync()); };
    const flush = () => { if (timer) clearTimeout(timer); save(); };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    const unsubscribe = queryClient.getQueryCache().subscribe(() => { timer ??= setTimeout(save, 1500); });
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      unsubscribe(); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden);
      if (timer) clearTimeout(timer);
    };
  }, [queryClient]);
  const recovery = useUnauthorizedRecovery(supabase, queryClient);
  const { handleUnauthorized } = recovery;
  useEffect(() => {
    onUnauthorizedRef.current = () => void handleUnauthorized();
  }, [handleUnauthorized]);
  const accessTokenRef = useRef<string | null>(null);
  const sessionPromiseRef = useRef<Promise<string | null> | null>(null);

  if (!sessionPromiseRef.current) {
    sessionPromiseRef.current = supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        accessTokenRef.current = session?.access_token ?? null;
        return accessTokenRef.current;
      })
      .catch(() => null);
  }

  // Listen for auth state changes and invalidate queries
  useEffect(() => {
    let isMounted = true;

    sessionPromiseRef.current
      ?.then((token) => {
        if (isMounted) {
          accessTokenRef.current = token;
        }
      })
      .catch(() => undefined);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        accessTokenRef.current = session?.access_token ?? null;
        sessionPromiseRef.current = Promise.resolve(accessTokenRef.current);

        // Signing out, or a different user signing in on this browser: nothing the last user read stays in memory or in storage.
        const user = session?.user?.id?.toLowerCase() ?? null;
        if (event === 'SIGNED_OUT' || (user && knownUser.current && user !== knownUser.current)) {
          clearPersistedCache();
          queryClient.clear();
          setEpoch(count => count + 1);
        }
        knownUser.current = event === 'SIGNED_OUT' ? null : user ?? knownUser.current;
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
          queryClient.invalidateQueries({ refetchType: 'active' });
        }
      }
    );

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [queryClient, supabase]);

  // Create tRPC client with Authorization header
  const [trpcClient] = useState(() => {
    const options = {
      url: '/api/trpc',
      maxItems: TRPC_MAX_BATCH_CALLS, // The proxy rejects larger batches (ARCH-FIX A1).
      async headers() {
        const token =
          accessTokenRef.current ??
          (await sessionPromiseRef.current?.catch(() => null)) ??
          null;

        if (token) return { Authorization: `Bearer ${token}` };
        return {};
      },
    };
    // Refresh a token close to expiry before Runtime needs it, and retry its refusal once.
    const session = createSessionRefresher({
      getSession: () => supabase.auth.getSession(),
      refreshSession: () => supabase.auth.refreshSession(),
      onToken: token => { accessTokenRef.current = token; sessionPromiseRef.current = Promise.resolve(token); },
    });
    return trpc.createClient({ links: [sessionRefreshLink(session), splitLink({
      condition: op => trpcLinkKind(op.path) === 'single',
      true: httpLink(options),
      false: httpBatchLink(options),
    })] });
  });

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Fragment key={epoch}>{children}</Fragment>
        {recovery.notice && (
          <UnauthorizedNotice
            reason={recovery.notice}
            busy={recovery.relogging}
            onRelogin={() => void recovery.relogin()}
          />
        )}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
