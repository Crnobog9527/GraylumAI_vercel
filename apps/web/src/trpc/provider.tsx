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

export default function Provider({ children }: { children: React.ReactNode }) {
  // The query client is created once; it reaches the latest recovery handler through this ref.
  const onUnauthorizedRef = useRef<() => void>(() => undefined);
  const [queryClient] = useState(() => {
    const onError = (error: unknown) => {
      if (isUnauthorizedError(error)) onUnauthorizedRef.current();
    };
    return new QueryClient({
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
      // Entry must not wait for unrelated sidebar statistics in the same batch.
      condition: op => op.path === 'workbench.chatLocate' || op.path === 'workbench.chatOpen',
      true: httpLink(options),
      // Streamed procedures deliver events as they happen; one mentor turn is
      // one streamed request (admission, then execution progress).
      false: splitLink({
        condition: op => op.path === 'runtime.executeStream' || op.path === 'opc.mentorTurnStream',
        true: httpBatchStreamLink(options),
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
