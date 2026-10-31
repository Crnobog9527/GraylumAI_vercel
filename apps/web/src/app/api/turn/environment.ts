import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readTurnRouteEnv } from '@repo/api/src/lib/envValidator';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

/** CORE-PATH-V2: what every /api/turn request needs: the service client, the signed-in account, the declared database host. */
export function turnEnvironment(request: NextRequest):
  { admin: SupabaseClient; authenticate: (req: Request) => Promise<string | null>; userClient: () => SupabaseClient;
    databaseHost: { declared: string | undefined; actual: string } }
  | null {
  const { url, anonKey: anon, serviceKey: service, databaseHost } = readTurnRouteEnv();
  if (!url || !anon || !service) return null;
  const userClient = (): SupabaseClient => {
    const bearer = request.headers.get('authorization');
    return bearer?.startsWith('Bearer ')
      ? createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: bearer } } })
      : createServerClient(url, anon, {
        cookieOptions: resolveSupabaseCookieOptions(new URL(request.url).hostname.toLowerCase()),
        cookies: { getAll: () => request.cookies.getAll(), setAll: () => {} },
      });
  };
  return {
    admin: createClient(url, service, { auth: { persistSession: false } }),
    userClient,
    async authenticate() {
      const { data } = await userClient().auth.getUser();
      return data.user?.id ?? null;
    },
    databaseHost: { declared: databaseHost, actual: new URL(url).host },
  };
}
