'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import React, { useState, useEffect, useRef } from 'react';
import { trpc } from '@/trpc/client';
import { createClient } from '@/lib/supabase';

export default function Provider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({}));
  const supabaseRef = useRef(createClient());
  // Store access token in ref for immediate access
  const accessTokenRef = useRef<string | null>(null);

  // Initialize session on mount
  useEffect(() => {
    const supabase = supabaseRef.current;

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      accessTokenRef.current = session?.access_token ?? null;
    });

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        accessTokenRef.current = session?.access_token ?? null;
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') {
          queryClient.invalidateQueries();
        }
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [queryClient]);

  // Create tRPC client with Authorization header
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: '/api/trpc',
          headers() {
            const token = accessTokenRef.current;
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
