'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import React, { useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { createClient } from '@/lib/supabase';

export default function Provider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  const [supabase] = useState(() => createClient());
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
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: '/api/trpc',
          async headers() {
            const token =
              accessTokenRef.current ??
              (await sessionPromiseRef.current?.catch(() => null)) ??
              null;

            if (token) {
              return {
                Authorization: `Bearer ${token}`,
              };
            }
            return {};
          },
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
