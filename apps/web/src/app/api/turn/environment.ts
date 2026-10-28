import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

/** CORE-PATH-V2: what every /api/turn request needs: the service client, the signed-in account, the declared database host. */
export function turnEnvironment(request: NextRequest):
  { admin: SupabaseClient; authenticate: (req: Request) => Promise<string | null>; databaseHost: { declared: string | undefined; actual: string } }
  | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return null;
  return {
    admin: createClient(url, service, { auth: { persistSession: false } }),
    async authenticate(req) {
      const bearer = req.headers.get('authorization');
      const auth = bearer?.startsWith('Bearer ')
        ? createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: bearer } } })
        : createServerClient(url, anon, {
          cookieOptions: resolveSupabaseCookieOptions(new URL(request.url).hostname.toLowerCase()),
          cookies: { getAll: () => request.cookies.getAll(), setAll: () => {} },
        });
      const { data } = await auth.auth.getUser();
      return data.user?.id ?? null;
    },
    databaseHost: { declared: process.env.TURN_DATABASE_HOST, actual: new URL(url).host },
  };
}
