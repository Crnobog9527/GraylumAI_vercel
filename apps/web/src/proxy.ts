import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { isEmailVerified, sanitizeRedirectTarget } from '@/lib/auth';
import { logServerError } from '@/lib/server-log';
import { resolveAuthAppUrl, resolveSupabaseCookieOptions } from '@/lib/site-config';

const SENTRY_TUNNEL_PATH = '/monitoring';

// 公开路径 - 不需要认证
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/verify-email',
  '/maintenance',
  '/contact',
  '/tutorials',
  '/faq',
  '/terms',
  '/privacy',
  '/acceptable-use',
  '/auth',
  '/landing',
  '/api',
  '/_next',
  '/_vercel',
  '/favicon.ico',
];

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

export function isAppDomain(hostname: string): boolean {
  return hostname === 'app.graylum.com' || hostname.endsWith('.app.graylum.com');
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

// 判断是否为公开路径
function isPublicPath(pathname: string): boolean {
  if (isSentryTunnelPath(pathname)) {
    return true;
  }

  return PUBLIC_PATHS.some(path => pathname.startsWith(path));
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

// 创建 Redis 速率限制器 (懒加载)
let rateLimiter: Ratelimit | null = null;
let maintenanceCache: { enabled: boolean; expiresAt: number } | null = null;

function shouldFailClosedRateLimit(): boolean {
  return process.env.RATE_LIMIT_FAIL_CLOSED === 'true';
}

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
      message: '速率限制服务暂时不可用，请稍后再试',
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

function getRateLimiter(): Ratelimit | null {
  if (rateLimiter) return rateLimiter;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // 未配置 Redis，跳过速率限制
    return null;
  }

  try {
    const redis = new Redis({ url, token });
    rateLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(60, '1 m'), // 60 requests per minute
      prefix: 'graylum:middleware:',
      analytics: true,
    });
    return rateLimiter;
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hostname = request.nextUrl.hostname || request.headers.get('host') || '';
  const normalizedHostname = hostname.split(':')[0].toLowerCase();

  // ========================================
  // 速率限制检查 (API 路径)
  // ========================================
  if (needsRateLimit(pathname)) {
    const limiter = getRateLimiter();
    if (!limiter && shouldFailClosedRateLimit()) {
      return createRateLimitUnavailableResponse();
    }

    if (limiter) {
      const ip = getClientIP(request);
      const identifier = ip;

      try {
        const result = await limiter.limit(identifier);

        if (!result.success) {
          const retryAfter = Math.ceil((result.reset - Date.now()) / 1000);
          return new NextResponse(
            JSON.stringify({
              error: 'Too Many Requests',
              message: `请求过于频繁，请在 ${retryAfter} 秒后重试`,
              retryAfter,
            }),
            {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'X-RateLimit-Limit': result.limit.toString(),
                'X-RateLimit-Remaining': result.remaining.toString(),
                'X-RateLimit-Reset': result.reset.toString(),
                'Retry-After': retryAfter.toString(),
              },
            }
          );
        }
      } catch {
        if (shouldFailClosedRateLimit()) {
          logServerError('security', 'proxy_rate_limit_check_failed_denying_request');
          return createRateLimitUnavailableResponse();
        }

        logServerError('security', 'proxy_rate_limit_check_failed_allowing_request');
      }
    }
  }

  // 判断域名类型
  const isAppDomainMatch = isAppDomain(normalizedHostname);
  const isPublicSiteDomain =
    normalizedHostname === 'graylum.com' ||
    normalizedHostname === 'www.graylum.com' ||
    normalizedHostname.startsWith('www.');
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
  if (isPublicSiteDomain) {
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

  // app 域名: 应用后台 (需要认证)
  if (isAppDomainMatch || isPreviewDeploymentMatch) {
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
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
