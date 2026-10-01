import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { checkRateLimit } from '@/lib/rateLimit';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import { logServerError } from '@/lib/server-log';
import { isPublicPathname } from '@/lib/public-paths';
import { isPublicSiteHost, resolveAuthAppUrl, resolveSupabaseCookieOptions } from '@/lib/site-config';

const SENTRY_TUNNEL_PATH = '/monitoring';

// 公开站点路径 - 仅允许公共内容留在 public 域
const PUBLIC_SITE_PATHS = [
  '/maintenance',
  '/landing',
  '/contact',
  '/tutorials',
  '/faq',
  '/terms',
  '/privacy',
  '/acceptable-use',
  '/api',
  '/_next',
  '/_vercel',
  '/favicon.ico',
];

const PUBLIC_PRICING_ENTRY_PATHS = [
  '/pricing',
  '/plans',
];

// 需要速率限制的 API 路径
const RATE_LIMITED_PATHS = [
  '/api/ai/stream',
  '/api/trpc',
];

export function normalizeHostname(hostname: string): string {
  return hostname.split(':')[0].toLowerCase().replace(/\.$/, '');
}

export function isPreviewDeployment(hostname: string): boolean {
  return hostname.endsWith('.vercel.app');
}

export function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
}

export function isDevEnvironment(hostname: string): boolean {
  return isLocalhost(hostname) || hostname.endsWith('.github.dev') || hostname.endsWith('.gitpod.io');
}

export function isPublicSiteDomain(hostname: string): boolean {
  return isPublicSiteHost(hostname);
}

// Every host that is not the public site or a local/dev host is an app host and requires login,
// so a newly added domain (for example a staging domain) is protected without a code change.
export function requiresAppAuth(hostname: string): boolean {
  return !isPublicSiteDomain(hostname) && !isDevEnvironment(hostname);
}

// 判断是否为公开路径
function isPublicPath(pathname: string): boolean {
  if (isSentryTunnelPath(pathname)) {
    return true;
  }

  return isPublicPathname(pathname);
}

function isPublicSitePath(pathname: string): boolean {
  if (isSentryTunnelPath(pathname)) {
    return true;
  }

  return PUBLIC_SITE_PATHS.some(path => pathname.startsWith(path));
}

function isPublicPricingEntryPath(pathname: string): boolean {
  return PUBLIC_PRICING_ENTRY_PATHS.some(path => pathname === path || pathname === `${path}/`);
}

function isSentryTunnelPath(pathname: string): boolean {
  return pathname === SENTRY_TUNNEL_PATH || pathname.startsWith(`${SENTRY_TUNNEL_PATH}/`);
}

function createPublicPricingRedirect(request: NextRequest): NextResponse {
  const pricingUrl = request.nextUrl.clone();
  pricingUrl.pathname = '/landing';
  pricingUrl.hash = 'pricing';
  return NextResponse.redirect(pricingUrl);
}

// 判断是否需要速率限制
function needsRateLimit(pathname: string): boolean {
  return RATE_LIMITED_PATHS.some(path => pathname.startsWith(path));
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
  if (needsRateLimit(pathname)) {
    const result = await checkRateLimit(getClientIP(request), 'ip');
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

  // 判断域名类型
  const requiresAppAuthMatch = requiresAppAuth(normalizedHostname);
  const isPublicSiteDomainMatch = isPublicSiteDomain(normalizedHostname);
  const isPreviewDeploymentMatch = isPreviewDeployment(normalizedHostname);
  const isDevEnvironmentMatch = isDevEnvironment(normalizedHostname);
  const domainParam = request.nextUrl.searchParams.get('domain');
  const isPreviewPublicSitePricingEntry =
    isPreviewDeploymentMatch && domainParam === 'www' && isPublicPricingEntryPath(pathname);

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
  // 认证与路由逻辑
  // ========================================

  if (isPreviewPublicSitePricingEntry) {
    return createPublicPricingRedirect(request);
  }

  // 公开站点域名: 展示着陆页 (公开访问)
  if (isPublicSiteDomainMatch) {
    // 根路径重写到着陆页
    if (pathname === '/') {
      const url = request.nextUrl.clone();
      url.pathname = '/landing';
      return NextResponse.rewrite(url);
    }

    if (isPublicPricingEntryPath(pathname)) {
      return createPublicPricingRedirect(request);
    }

    if (isPublicSitePath(pathname)) {
      return supabaseResponse;
    }

    const appUrl = new URL(`${pathname}${request.nextUrl.search}`, resolveAuthAppUrl());
    return NextResponse.redirect(appUrl);
  }

  if (maintenanceModeEnabled && !isAdminUser && !isMaintenanceBypassPath(pathname)) {
    const maintenanceUrl = new URL('/maintenance', request.url);
    maintenanceUrl.searchParams.set('from', `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(maintenanceUrl);
  }

  if (maintenanceModeEnabled && isAdminUser && pathname === '/maintenance') {
    return NextResponse.redirect(new URL('/admin', request.url));
  }

  // www 域名允许所有访问，不需要认证
  if (isPublicSitePath(pathname)) {
    return supabaseResponse;
  }

  // 应用域名（app、staging、预览及任何未单独列出的域名）: 需要认证
  if (requiresAppAuthMatch) {
    // 公开路径允许访问
    if (isPublicPath(pathname)) {
      // 已登录用户访问登录页时重定向到首页
      if ((pathname === '/login' || pathname === '/register') && user) {
        const requestedRedirect = sanitizeRedirectTarget(request.nextUrl.searchParams.get('redirect'));
        if (!userIsVerified) {
          const verifyUrl = new URL('/verify-email', request.url);
          verifyUrl.searchParams.set('email', user.email ?? '');
          verifyUrl.searchParams.set('redirect', requestedRedirect);
          return NextResponse.redirect(verifyUrl);
        }
        return NextResponse.redirect(new URL(requestedRedirect, request.url));
      }
      return supabaseResponse;
    }

    // 非公开路径需要登录
    if (!user) {
      const loginUrl = new URL('/login', request.url);
      const redirectTarget = `${pathname}${request.nextUrl.search}`;
      loginUrl.searchParams.set('redirect', redirectTarget);
      return NextResponse.redirect(loginUrl);
    }

    if (!userIsVerified) {
      const verifyUrl = new URL('/verify-email', request.url);
      verifyUrl.searchParams.set('email', user.email ?? '');
      verifyUrl.searchParams.set('redirect', `${pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(verifyUrl);
    }

    return supabaseResponse;
  }

  // 开发环境 (localhost / GitHub Codespaces / Gitpod): 根据查询参数判断
  if (isDevEnvironmentMatch) {
    // 开发环境使用查询参数 ?domain=www 模拟 www 域名
    if (domainParam === 'www') {
      if (isPublicPricingEntryPath(pathname)) {
        return createPublicPricingRedirect(request);
      }

      // 根路径重写到着陆页
      if (pathname === '/' || pathname === '') {
        // 使用 redirect 而非 rewrite 确保页面正确加载
        const landingUrl = new URL('/landing', request.url);
        landingUrl.searchParams.set('domain', 'www');
        return NextResponse.redirect(landingUrl);
      }
      // /landing 路径直接访问，允许公开访问
      if (pathname === '/landing') {
        return supabaseResponse;
      }
      // 模拟 www 域名，公开访问
      return supabaseResponse;
    }

    // 默认行为: 模拟 app 域名逻辑
    // /landing 路径在开发环境始终允许访问
    if (pathname === '/landing') {
      return supabaseResponse;
    }

    if (!isPublicPath(pathname) && !user) {
      const loginUrl = new URL('/login', request.url);
      const redirectTarget = `${pathname}${request.nextUrl.search}`;
      loginUrl.searchParams.set('redirect', redirectTarget);
      return NextResponse.redirect(loginUrl);
    }

    if (!isPublicPath(pathname) && user && !userIsVerified) {
      const verifyUrl = new URL('/verify-email', request.url);
      verifyUrl.searchParams.set('email', user.email ?? '');
      verifyUrl.searchParams.set('redirect', `${pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(verifyUrl);
    }

    // 已登录用户访问登录页时重定向到首页
    if ((pathname === '/login' || pathname === '/register') && user) {
      const requestedRedirect = sanitizeRedirectTarget(request.nextUrl.searchParams.get('redirect'));
      if (!userIsVerified) {
        const verifyUrl = new URL('/verify-email', request.url);
        verifyUrl.searchParams.set('email', user.email ?? '');
        verifyUrl.searchParams.set('redirect', requestedRedirect);
        return NextResponse.redirect(verifyUrl);
      }
      return NextResponse.redirect(new URL(requestedRedirect, request.url));
    }
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
     * - robots.txt (exact public crawler file)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|fonts/misans/|favicon.ico|robots\\.txt$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
