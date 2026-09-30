import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext } from '@repo/api/src/trpc';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import { buildVerifyEmailPath, routeCallbackError } from '@/lib/authFlow';
import { logServerError } from '@/lib/server-log';
import { resolveAuthCallbackOrigin, resolveSupabaseCookieOptions } from '@/lib/site-config';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const hostname = requestUrl.hostname.toLowerCase();
  const code = requestUrl.searchParams.get('code');
  const next = sanitizeRedirectTarget(requestUrl.searchParams.get('next'));

  const authOrigin = resolveAuthCallbackOrigin(requestUrl.origin);
  let response = NextResponse.redirect(new URL(next, authOrigin));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: resolveSupabaseCookieOptions(hostname),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const loginError = () => {
    const loginUrl = new URL('/login', authOrigin);
    loginUrl.searchParams.set('error', 'callback_failed');
    return NextResponse.redirect(loginUrl);
  };

  // An email link that failed (expired, already used) arrives with error params and no code.
  const linkError = routeCallbackError(requestUrl.searchParams);
  if (linkError) {
    logServerError('auth', 'auth_callback_link_error');
    return linkError.to === 'verify-expired'
      ? NextResponse.redirect(new URL(buildVerifyEmailPath('', next, 'expired'), authOrigin))
      : loginError();
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      logServerError('auth', 'auth_callback_session_exchange_failed');
      return loginError();
    }
  }

  const { data: { user } } = await supabase.auth.getUser();

  // No session: a link GoTrue answered in the URL fragment (resent links do not use PKCE), which
  // the server never sees. The browser keeps that fragment across this redirect and the login
  // page reads it, so an expired resent link still reaches the resend page.
  if (!user) {
    const loginUrl = new URL('/login', authOrigin);
    loginUrl.searchParams.set('redirect', next);
    return NextResponse.redirect(loginUrl);
  }

  if (!isEmailVerified(user)) {
    return NextResponse.redirect(new URL(buildVerifyEmailPath(user.email ?? '', next), authOrigin));
  }

  const pendingInviteCode =
    user.user_metadata && typeof user.user_metadata.invite_code === 'string'
      ? user.user_metadata.invite_code.trim()
      : '';

  if (pendingInviteCode) {
    try {
      const ctx = await createTRPCContext({
        headers: request.headers,
        user,
        supabaseAuth: supabase,
      });
      const caller = appRouter.createCaller(ctx);
      await caller.invitation.claimInvitationCode({ code: pendingInviteCode });
    } catch {
      logServerError('auth', 'auth_callback_invitation_claim_failed');
    }
  }

  return response;
}
