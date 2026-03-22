import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import { resolveAuthAppUrl, resolveSupabaseCookieOptions } from '@/lib/site-config';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const hostname = requestUrl.hostname.toLowerCase();
  const code = requestUrl.searchParams.get('code');
  const next = sanitizeRedirectTarget(requestUrl.searchParams.get('next'));

  let response = NextResponse.redirect(new URL(next, resolveAuthAppUrl()));

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

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      const loginUrl = new URL('/login', resolveAuthAppUrl());
      loginUrl.searchParams.set('error', error.message);
      return NextResponse.redirect(loginUrl);
    }
  }

  const { data: { user } } = await supabase.auth.getUser();

  if (user && !isEmailVerified(user)) {
    const verifyUrl = new URL('/verify-email', resolveAuthAppUrl());
    verifyUrl.searchParams.set('email', user.email ?? '');
    verifyUrl.searchParams.set('redirect', next);
    return NextResponse.redirect(verifyUrl);
  }

  return response;
}
