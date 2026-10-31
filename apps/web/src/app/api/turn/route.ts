import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { readTurnRouteEnv } from '@repo/api/src/lib/envValidator';
import { withCatalogRequest } from '@repo/api/src/services/runtime/catalogCache';
import { withPlatformSecretRequest } from '@repo/api/src/services/platformSecrets/request';
import { checkRateLimit } from '@repo/api/src/services/redisRateLimiter';
import { handReviewToServer } from '@repo/api/src/services/fusion/background';
import { chatToolDeps } from '@repo/api/src/services/turn/chatToolDeps';
import { handleTurnRequest } from '@repo/api/src/services/turn/http';
import { handleTurnView } from '@repo/api/src/services/turn/view';
import { redisCounterStore } from '@repo/api/src/services/turn/limiter';
import { turnClients } from '@repo/api/src/services/turn/db';
import { newWorkGate } from '@repo/api/src/services/runtime/newWorkGate';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

export const runtime = 'nodejs';
// One turn per invocation, streamed to the end (CORE-PATH-V2 2.2); the same ceiling as the runtime stream.
export const maxDuration = 300;

/** The signed-in user's own client: a bearer token, or the session cookie. */
function userClient(request: NextRequest, url: string, anon: string) {
  const bearer = request.headers.get('authorization');
  return bearer?.startsWith('Bearer ')
    ? createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: bearer } } })
    : createServerClient(url, anon, {
      cookieOptions: resolveSupabaseCookieOptions(new URL(request.url).hostname.toLowerCase()),
      cookies: { getAll: () => request.cookies.getAll(), setAll: () => {} },
    });
}

/** The signed-in account of a turn request. */
function authenticator(request: NextRequest, url: string, anon: string) {
  return async () => {
    const { data } = await userClient(request, url, anon).auth.getUser();
    return data.user?.id ?? null;
  };
}

/** CORE-PATH-V2 POST /api/turn (chat, mentor, report, compare, jury). Off until system_settings core_path_v2.enabled; the page switches in V2-10. */
export async function POST(request: NextRequest) {
  const { url, anonKey: anon, serviceKey: service, databaseHost, environment } = readTurnRouteEnv();
  if (!url || !anon || !service) return new Response(JSON.stringify({ error: 'TURN_CONFIGURATION' }), { status: 503 });
  const admin = createClient(url, service, { auth: { persistSession: false } });
  return withPlatformSecretRequest(() => withCatalogRequest(() => handleTurnRequest(request, {
    authenticate: authenticator(request, url, anon),
    rateLimited: async actorId => !(await checkRateLimit(actorId, 'ai_stream')).success,
    databaseHost: { declared: databaseHost, actual: new URL(url).host },
    chat: { admin, clients: turnClients(admin), slots: redisCounterStore(), newWork: newWorkGate(admin, environment),
      tools: chatToolDeps(admin, () => userClient(request, url, anon)) },
    userClient: () => userClient(request, url, anon),
    handReview: reviewId => handReviewToServer({ scheduleAfter: task => after(task), origin: new URL(request.url).origin,
      supabaseAdmin: admin }, reviewId),
  })));
}

/** CORE-PATH-V2 GET /api/turn?sessionId=&afterSeq= (V2-5b): the refresh-recovery read of a conversation's turn (#595). */
export async function GET(request: NextRequest) {
  const { url, anonKey: anon, serviceKey: service, databaseHost } = readTurnRouteEnv();
  if (!url || !anon || !service) return new Response(JSON.stringify({ error: 'TURN_CONFIGURATION' }), { status: 503 });
  const admin = createClient(url, service, { auth: { persistSession: false } });
  return handleTurnView(request, { authenticate: authenticator(request, url, anon),
    databaseHost: { declared: databaseHost, actual: new URL(url).host }, clients: turnClients(admin) });
}
