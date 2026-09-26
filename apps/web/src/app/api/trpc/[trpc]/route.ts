import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext,createRuntimeBudget,withRuntimeBudget } from '@repo/api/src/trpc';

export const maxDuration = 300;
import { logServerError } from '@/lib/server-log';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';
import {
  isTrpcRequestAllowedDuringMaintenance,
  parseTrpcProcedurePaths,
} from '@/lib/trpc-maintenance';

function shouldFailClosedMaintenance(): boolean {
  if (process.env.VERCEL_ENV) {
    return process.env.VERCEL_ENV === 'production';
  }

  return process.env.NODE_ENV === 'production';
}

async function isMaintenanceModeEnabled(budgetFetch:typeof fetch): Promise<boolean> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    logServerError('system', 'trpc_service_role_key_missing');
    return shouldFailClosedMaintenance();
  }

  const maintenanceClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {global:{fetch:budgetFetch}},
  );

  const { data, error } = await maintenanceClient
    .from('system_settings')
    .select('value')
    .eq('key', 'maintenance_mode')
    .maybeSingle();

  if (error) {
    logServerError('system', 'trpc_maintenance_mode_read_failed', {
      code: error.code,
    });
    return shouldFailClosedMaintenance();
  }

  return data?.value === true || data?.value === 'true';
}

const handler = async (req: NextRequest) => {
  // Before authentication/maintenance: batched procedures share this deadline.
  const runtimeBudget=createRuntimeBudget();
  const budgetFetch=withRuntimeBudget(runtimeBudget,fetch,true);
  const hostname = new URL(req.url).hostname.toLowerCase();
  const authClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global:{fetch:budgetFetch},
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
  const maintenanceModeEnabled = await isMaintenanceModeEnabled(budgetFetch);

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
      runtimeBudget,
      user,
      supabaseAuth: authClient,
    }),
  });
};

export { handler as GET, handler as POST };
