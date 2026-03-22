import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext } from '@repo/api/src/trpc';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

const handler = async (req: NextRequest) => {
  const hostname = new URL(req.url).hostname.toLowerCase();
  const authClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: resolveSupabaseCookieOptions(hostname),
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Route handlers do not need to mutate cookies for read-only auth checks.
        },
      },
    }
  );

  const { data: { user } } = await authClient.auth.getUser();

  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext({
      headers: req.headers,
      user,
      supabaseAuth: authClient,
    }),
  });
};

export { handler as GET, handler as POST };
