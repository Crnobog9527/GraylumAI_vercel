'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, httpBatchStreamLink, httpLink, splitLink } from '@trpc/client';
import React, { useEffect, useRef, useState } from 'react';
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
      mutationCache: new MutationCache({ onError }),
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
      condition: op => trpcLinkKind(op.path) === 'stream',
      true: httpBatchStreamLink(options),
      false: splitLink({
        condition: op => trpcLinkKind(op.path) === 'single',
        true: httpLink(options),
        false: httpBatchLink(options),
      }),
    })] });
  });

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
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
