import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { checkRateLimit } from '@/lib/rateLimit';
import { TRPC_MAX_BATCH_CALLS, trpcCallCount } from '@/lib/trpcBatchLimit';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import { buildVerifyEmailPath, routeCallbackError } from '@/lib/authFlow';
import { logServerError } from '@/lib/server-log';
import { isPublicPathname } from '@/lib/public-paths';
import { BUY_INTENT_PATH, buyIntentPath, parseBuyIntent } from '@/lib/buyIntent';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';
import { withEntryLanguage } from '@/lib/entry-language-server';

const SENTRY_TUNNEL_PATH = '/monitoring';

// Public site content: open to everyone and still served while maintenance mode is on, like the public
// host was before the single-host move (E1). Login entry pages are public too but not in this list.
const PUBLIC_SITE_PATHS = [
  '/maintenance',
  '/landing',
  '/contact',
  '/faq',
  '/terms',
  '/privacy',
  '/api',
  '/_next',
  '/_vercel',
  '/favicon.ico',
];

// Public site pages added by PUBLIC-SITE. Unlike the prefix list above, these match whole path segments
// only: /zh-tw and /zh-tw/... are public, /zh-twx is not. /refund is the public refund policy
// (Owner 2026-10-17), matched by segment so /refunds and /refund-x still need login.
const PUBLIC_SITE_PAGE_PATHS = [
  '/about',
  '/features', // Product feature pages (/features and /features/<name>) linked from the public header and footer.
  '/blog', // The tutorial blog (/blog and /blog/<article>), linked from the public header as 教程.
  '/zh-tw',
  '/refund',
  '/refund-policy', // The formal refund policy text; /refund stays the plain-language summary.
  '/cookies', // The cookie policy text.
  '/accessibility', // The public accessibility statement, linked from every public footer.
  '/founders', // The founder members' wall: read-only, shows only approved cards the member agreed to publish.
  '/graylum-vs-chatgpt', // The Graylum vs ChatGPT comparison page (the Taiwan version is under /zh-tw).
  '/pricing', // The public pricing page (moved from /landing/pricing on 2026-10-18; the old address 308s here).
];

// Other names people type for the pricing page; they lead to it.
const PUBLIC_PRICING_ENTRY_PATHS = [
  '/plans',
];

// 需要速率限制的 API 路径
const RATE_LIMITED_PATHS = [
  '/api/trpc',
  '/api/upload', // Ticket attachment uploads (ARCH-FIX A1).
];

export function normalizeHostname(hostname: string): string {
  return hostname.split(':')[0].toLowerCase().replace(/\.$/, '');
}

// 判断是否为公开路径
function isPublicPath(pathname: string): boolean {
  if (isSentryTunnelPath(pathname)) {
    return true;
  }

  return isPublicPathname(pathname);
}

function isPublicSitePath(pathname: string): boolean {
  if (pathname === '/' || isSentryTunnelPath(pathname)) {
    return true;
  }

  return (
    PUBLIC_SITE_PATHS.some(path => pathname.startsWith(path)) ||
    PUBLIC_SITE_PAGE_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))
  );
}

function isPublicPricingEntryPath(pathname: string): boolean {
  return PUBLIC_PRICING_ENTRY_PATHS.some(path => pathname === path || pathname === `${path}/`);
}

function isSentryTunnelPath(pathname: string): boolean {
  return pathname === SENTRY_TUNNEL_PATH || pathname.startsWith(`${SENTRY_TUNNEL_PATH}/`);
}

// A response other than the session response keeps the cookies a session refresh just wrote.
function withSessionCookies(response: NextResponse, sessionResponse: NextResponse): NextResponse {
  sessionResponse.cookies.getAll().forEach(cookie => response.cookies.set(cookie));
  return response;
}

function createPublicPricingRedirect(request: NextRequest): NextResponse {
  // The public pricing page (PAYWALL); query parameters such as ?domain=www are kept.
  return NextResponse.redirect(new URL(`/pricing${request.nextUrl.search}`, request.url));
}

// A logged-out visitor goes to login and comes back to the page afterwards. A landing-page buy link opens
// sign-up instead (the visitor can switch to login there) and returns to that plan's checkout dialog; the return
// path is rebuilt from the allowed plan values only (Owner 2026-10-17, lib/buyIntent).
function createLoginRedirect(request: NextRequest): NextResponse {
  const { pathname, search, searchParams } = request.nextUrl;
  const loginUrl = new URL('/login', request.url);
  const intent = pathname === BUY_INTENT_PATH ? parseBuyIntent(searchParams) : null;
  if (intent) loginUrl.searchParams.set('action', 'signup');
  loginUrl.searchParams.set('redirect', intent ? buyIntentPath(intent) : `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

// 判断是否需要速率限制
function needsRateLimit(pathname: string): boolean {
  return RATE_LIMITED_PATHS.some(path => pathname.startsWith(path));
}

// A bearer token or a Supabase session cookie (sb-<ref>-auth-token, possibly chunked). Not verified here:
// a forged one only moves the caller to the wider per-IP guard, and the API still checks the login.
function carriesLogin(request: NextRequest): boolean {
  return /^Bearer \S/.test(request.headers.get('authorization') ?? '')
    || request.cookies.getAll().some(({ name }) => /^sb-.+-auth-token(\.\d+)?$/.test(name));
}

function isMaintenanceBypassPath(pathname: string): boolean {
  if (isSentryTunnelPath(pathname)) {
    return true;
  }

  return (
    pathname === '/maintenance' ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/_vercel') ||
    pathname === '/favicon.ico'
  );
}

// 获取客户端 IP
function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIP = request.headers.get('x-real-ip');
  if (realIP) {
    return realIP;
  }
  return 'unknown';
}

// GoTrue sends email and OAuth links to /auth/callback. Only when it does not accept the requested
// redirect does it fall back to the Site URL root, so only the root is handled here: a code goes to
// the server callback, which exchanges it with the verifier cookie this request carries (with
// duplicate cookie names the browser client reads the older one first), the expired-link error
// code goes to the resend page and other errors go to login. Codes on any other page keep their handling.
export function routeAuthLanding(request: NextRequest): NextResponse | null {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname !== '/') {
    return null;
  }

  const code = searchParams.get('code');
  if (code) {
    const callbackUrl = new URL('/auth/callback', request.url);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('next', sanitizeRedirectTarget(`${pathname}${request.nextUrl.search}`));
    return NextResponse.redirect(callbackUrl);
  }

  const callbackError = routeCallbackError(searchParams)?.to;
  if (callbackError === 'verify-expired') {
    return NextResponse.redirect(new URL(buildVerifyEmailPath('/app/profile', 'expired'), request.url));
  }

  // Any other error goes to the login page, which shows it, as when the root still needed login; the root
  // itself is now the public home page and would drop it.
  if (callbackError === 'login-error') {
    return createLoginRedirect(request);
  }

  return null;
}

let maintenanceCache: { enabled: boolean; expiresAt: number } | null = null;

function shouldFailClosedMaintenance(): boolean {
  if (process.env.VERCEL_ENV) {
    return process.env.VERCEL_ENV === 'production';
  }

  return process.env.NODE_ENV === 'production';
}

function createRateLimitUnavailableResponse(): NextResponse {
  return new NextResponse(
    JSON.stringify({
      error: 'Service Unavailable',
      message: '服务暂时繁忙，请稍后再试',
      retryAfter: 60,
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
      },
    }
  );
}

async function isMaintenanceModeEnabled(
  _request: NextRequest
): Promise<boolean> {
  if (maintenanceCache && maintenanceCache.expiresAt > Date.now()) {
    return maintenanceCache.enabled;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    logServerError('system', 'proxy_service_role_key_missing');
    const enabled = shouldFailClosedMaintenance();
    maintenanceCache = { enabled, expiresAt: Date.now() + 1_000 };
    return enabled;
  }

  try {
    const maintenanceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const { data, error } = await maintenanceClient
      .from('system_settings')
      .select('value')
      .eq('key', 'maintenance_mode')
      .maybeSingle();

    if (error) {
      logServerError('system', 'proxy_maintenance_mode_read_failed', {
        code: error.code,
      });
      const enabled = shouldFailClosedMaintenance();
      maintenanceCache = { enabled, expiresAt: Date.now() + 1_000 };
      return enabled;
    }

    const enabled = data?.value === true || data?.value === 'true';
    maintenanceCache = { enabled, expiresAt: Date.now() + 2_000 };
    return enabled;
  } catch {
    logServerError('system', 'proxy_maintenance_mode_unexpected_error');
    const enabled = shouldFailClosedMaintenance();
    maintenanceCache = { enabled, expiresAt: Date.now() + 1_000 };
    return enabled;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hostname = request.nextUrl.hostname || request.headers.get('host') || '';
  const normalizedHostname = normalizeHostname(hostname);

  // ========================================
  // 速率限制检查 (API 路径)
  // ========================================
  if (trpcCallCount(pathname, request.nextUrl.searchParams) > TRPC_MAX_BATCH_CALLS) {
    return NextResponse.json({ error: 'Bad Request', message: `一次最多 ${TRPC_MAX_BATCH_CALLS} 个请求` }, { status: 400 });
  }
  if (needsRateLimit(pathname)) {
    const result = await checkRateLimit(getClientIP(request), carriesLogin(request) ? 'ip_session' : 'ip');
    if (result.reason === 'unavailable') return createRateLimitUnavailableResponse();
    if (!result.success) {
      const retryAfter = result.retryAfter ?? 60;
      return NextResponse.json({
        error: 'Too Many Requests',
        message: `请求过于频繁，请在 ${retryAfter} 秒后重试`,
        retryAfter,
      }, {
        status: 429,
        headers: {
          'X-RateLimit-Limit': result.limit.toString(),
          'X-RateLimit-Remaining': result.remaining.toString(),
          'X-RateLimit-Reset': result.reset.toString(),
          'Retry-After': retryAfter.toString(),
        },
      });
    }
  }

  const authLandingRedirect = routeAuthLanding(request);
  if (authLandingRedirect) {
    return authLandingRedirect;
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: resolveSupabaseCookieOptions(normalizedHostname),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // 获取用户会话
  const { data: { user } } = await supabase.auth.getUser();
  const userIsVerified = isEmailVerified(user);
  const maintenanceModeEnabled = await isMaintenanceModeEnabled(request);
  let isAdminUser = false;

  if (maintenanceModeEnabled && user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    isAdminUser = profile?.role === 'admin';
  }

  // ========================================
  // 认证与路由逻辑：所有主机按路径判断（E1 单主机，SEO_GEO_SPEC 第 2、15 节）
  // ========================================

  if (isPublicPricingEntryPath(pathname)) {
    return createPublicPricingRedirect(request);
  }

  // The root is the public home page, served from /landing (whose own address 308s back to "/").
  if (pathname === '/') {
    const url = request.nextUrl.clone();
    url.pathname = '/landing';
    return withSessionCookies(NextResponse.rewrite(url, { request }), supabaseResponse);
  }

  if (maintenanceModeEnabled && isAdminUser && pathname === '/maintenance') {
    return NextResponse.redirect(new URL('/admin', request.url));
  }

  // Public site pages stay open, also during maintenance.
  if (isPublicSitePath(pathname)) {
    return supabaseResponse;
  }

  if (maintenanceModeEnabled && !isAdminUser && !isMaintenanceBypassPath(pathname)) {
    const maintenanceUrl = new URL('/maintenance', request.url);
    maintenanceUrl.searchParams.set('from', `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(maintenanceUrl);
  }

  // Login entry pages and the other public paths open without a session.
  if (isPublicPath(pathname)) {
    // 已登录用户访问登录页时重定向到回跳目标
    if ((pathname === '/login' || pathname === '/register') && user) {
      const requestedRedirect = sanitizeRedirectTarget(request.nextUrl.searchParams.get('redirect'));
      if (!userIsVerified) {
        const verifyUrl = new URL('/verify-email', request.url);
        verifyUrl.searchParams.set('redirect', requestedRedirect);
        return NextResponse.redirect(await withEntryLanguage(verifyUrl, request, null));
      }
      return NextResponse.redirect(await withEntryLanguage(new URL(requestedRedirect, request.url), request, user.id));
    }
    return supabaseResponse;
  }

  // Everything else (/app/*, /admin/* and any page not listed as public) needs a verified login.
  if (!user) {
    return createLoginRedirect(request);
  }

  if (!userIsVerified) {
    const verifyUrl = new URL('/verify-email', request.url);
    verifyUrl.searchParams.set('redirect', `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(verifyUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - fonts/misans/ (public font binaries and license notices only)
     * - fonts/noto-sans-cjk-display/ (style sample D's heading font and its license notice only)
     * - robots.txt, sitemap.xml (exact public crawler files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|fonts/misans/|fonts/noto-sans-cjk-display/|favicon.ico|robots\\.txt$|sitemap\\.xml$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
