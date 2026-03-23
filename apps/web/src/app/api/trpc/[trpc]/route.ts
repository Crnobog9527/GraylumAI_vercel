import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext } from '@repo/api/src/trpc';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';
import {
  isTrpcRequestAllowedDuringMaintenance,
  parseTrpcProcedurePaths,
} from '@/lib/trpc-maintenance';

async function isMaintenanceModeEnabled(): Promise<boolean> {
  const maintenanceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  const { data, error } = await maintenanceClient
    .from('system_settings')
    .select('value')
    .eq('key', 'maintenance_mode')
    .maybeSingle();

  if (error) {
    console.error('[tRPC Route] Failed to read maintenance mode:', error);
    return true;
  }

  return data?.value === true || data?.value === 'true';
}

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
  const maintenanceModeEnabled = await isMaintenanceModeEnabled();

  if (maintenanceModeEnabled) {
    let isAdminUser = false;

    if (user) {
      const { data: profile } = await authClient
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

      isAdminUser = profile?.role === 'admin';
    }

    if (!isAdminUser) {
      const procedurePaths = parseTrpcProcedurePaths(req.nextUrl.pathname);

      if (!isTrpcRequestAllowedDuringMaintenance(procedurePaths)) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: '系统维护中，暂时无法使用该接口',
            },
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      }
    }
  }

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
