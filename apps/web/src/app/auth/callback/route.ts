import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext } from '@repo/api/src/trpc';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import {
  buildVerifyEmailPath,
  classifyCodeExchangeError,
  parseAuthCallbackFlow,
  routeCallbackError,
  type LoginErrorCode,
} from '@/lib/authFlow';
import { buildForgotPasswordPath, classifyRecoveryExchangeError, type RecoveryFailure } from '@/lib/passwordRecovery';
import { logServerError } from '@/lib/server-log';
import { resolveAuthCallbackOrigin, resolveSupabaseCookieOptions } from '@/lib/site-config';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const hostname = requestUrl.hostname.toLowerCase();
  const code = requestUrl.searchParams.get('code');
  const next = sanitizeRedirectTarget(requestUrl.searchParams.get('next'));
  const flow = parseAuthCallbackFlow(requestUrl.searchParams.get('flow'));

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

  const loginError = (reason: LoginErrorCode = 'callback_failed') => {
    const loginUrl = new URL('/login', authOrigin);
    loginUrl.searchParams.set('error', reason);
    loginUrl.searchParams.set('redirect', next);
    return NextResponse.redirect(loginUrl);
  };
  // A failed password reset link goes back to the request page, which only shows fixed texts.
  const recoveryError = (reason: RecoveryFailure) =>
    NextResponse.redirect(new URL(buildForgotPasswordPath(reason), authOrigin));

  // An email link that failed (expired, already used) arrives with error params and no code.
  const linkError = routeCallbackError(requestUrl.searchParams);
  if (linkError) {
    logServerError('auth', 'auth_callback_link_error');
    if (flow === 'recovery') return recoveryError('expired');
    return linkError.to === 'verify-expired'
      ? NextResponse.redirect(new URL(buildVerifyEmailPath('', next, 'expired'), authOrigin))
      : loginError();
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error && flow === 'recovery') {
      const reason = classifyRecoveryExchangeError(error);
      logServerError('auth', 'auth_callback_session_exchange_failed', { reason });
      return recoveryError(reason);
    }

    if (error) {
      const reason = classifyCodeExchangeError(error, flow);
      logServerError('auth', 'auth_callback_session_exchange_failed', { reason });
      // A verifier mismatch usually means the link was opened where the flow did not start. For an
      // email link /verify has already confirmed the email, so the visitor should just log in; a
      // Google sign-in is simply retried. `flow` only picks the fixed message, never access.
      return loginError(reason);
    }
  }

  const { data: { user } } = await supabase.auth.getUser();

  // No session: a link GoTrue answered in the URL fragment (resent links do not use PKCE), which
  // the server never sees. The browser keeps that fragment across this redirect and the login
  // page reads it (readAuthFragment): an expired link goes to the resend page, a confirmed one
  // shows "please log in", and the fragment is cleared either way.
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
