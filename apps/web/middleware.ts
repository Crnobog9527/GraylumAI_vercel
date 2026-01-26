import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// 公开路径 - 不需要认证
const PUBLIC_PATHS = [
  '/login',
  '/landing',
  '/api',
  '/_next',
  '/favicon.ico',
];

// 需要速率限制的 API 路径
const RATE_LIMITED_PATHS = [
  '/api/ai/stream',
  '/api/trpc',
];

// 判断是否为公开路径
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(path => pathname.startsWith(path));
}

// 判断是否需要速率限制
function needsRateLimit(pathname: string): boolean {
  return RATE_LIMITED_PATHS.some(path => pathname.startsWith(path));
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hostname = request.headers.get('host') || '';

  // ========================================
  // 速率限制检查 (API 路径)
  // ========================================
  if (needsRateLimit(pathname)) {
    const limiter = getRateLimiter();
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
      } catch (error) {
        // Redis 错误时允许请求通过 (fail-open)
        console.error('[Middleware] Rate limit check failed:', error);
      }
    }
  }

  // 判断域名类型
  const isAppDomain = hostname.startsWith('app.') || hostname.includes('app.graylum.com');
  const isWwwDomain = hostname.startsWith('www.') || hostname.includes('www.graylum.com');
  const isLocalhost = hostname.includes('localhost') || hostname.includes('127.0.0.1');
  const isDevEnvironment = isLocalhost || hostname.includes('.github.dev') || hostname.includes('.gitpod.io');

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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

  // ========================================
  // 认证与路由逻辑
  // ========================================

  // www 域名: 展示着陆页 (公开访问)
  if (isWwwDomain) {
    // 根路径重写到着陆页
    if (pathname === '/') {
      const url = request.nextUrl.clone();
      url.pathname = '/landing';
      return NextResponse.rewrite(url);
    }
    // www 域名允许所有访问，不需要认证
    return supabaseResponse;
  }

  // app 域名: 应用后台 (需要认证)
  if (isAppDomain) {
    // 公开路径允许访问
    if (isPublicPath(pathname)) {
      // 已登录用户访问登录页时重定向到首页
      if (pathname === '/login' && user) {
        return NextResponse.redirect(new URL('/', request.url));
      }
      return supabaseResponse;
    }

    // 非公开路径需要登录
    if (!user) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }

    return supabaseResponse;
  }

  // 开发环境 (localhost / GitHub Codespaces / Gitpod): 根据查询参数判断
  if (isDevEnvironment) {
    // 开发环境使用查询参数 ?domain=www 模拟 www 域名
    const domainParam = request.nextUrl.searchParams.get('domain');

    if (domainParam === 'www') {
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
      loginUrl.searchParams.set('redirect', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // 已登录用户访问登录页时重定向到首页
    if (pathname === '/login' && user) {
      return NextResponse.redirect(new URL('/', request.url));
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
