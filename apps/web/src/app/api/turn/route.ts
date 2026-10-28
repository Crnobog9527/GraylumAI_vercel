import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { withCatalogRequest } from '@repo/api/src/services/runtime/catalogCache';
import { withPlatformSecretRequest } from '@repo/api/src/services/platformSecrets/request';
import { checkRateLimit } from '@repo/api/src/services/redisRateLimiter';
import { handleTurnRequest } from '@repo/api/src/services/turn/http';
import { redisCounterStore } from '@repo/api/src/services/turn/limiter';
import { turnClients } from '@repo/api/src/services/turn/db';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

export const runtime = 'nodejs';
// One turn per invocation, streamed to the end (CORE-PATH-V2 2.2); the same ceiling as the runtime stream.
export const maxDuration = 300;

/** CORE-PATH-V2 POST /api/turn (V2-4a: kind chat). Off until system_settings core_path_v2.enabled; the page switches in V2-10. */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return new Response(JSON.stringify({ error: 'TURN_CONFIGURATION' }), { status: 503 });
  const admin = createClient(url, service, { auth: { persistSession: false } });
  return withPlatformSecretRequest(() => withCatalogRequest(() => handleTurnRequest(request, {
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
    rateLimited: async actorId => !(await checkRateLimit(actorId, 'ai_stream')).success,
    databaseHost: { declared: process.env.TURN_DATABASE_HOST, actual: new URL(url).host },
    chat: { admin, clients: turnClients(admin), slots: redisCounterStore() },
  })));
}
