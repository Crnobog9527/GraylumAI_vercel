import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// 公开路径 - 不需要认证
const PUBLIC_PATHS = [
  '/login',
  '/api',
  '/_next',
  '/favicon.ico',
];

// 判断是否为公开路径
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(path => pathname.startsWith(path));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hostname = request.headers.get('host') || '';

  // 判断域名类型
  const isAppDomain = hostname.startsWith('app.') || hostname.includes('app.graylum.com');
  const isWwwDomain = hostname.startsWith('www.') || hostname.includes('www.graylum.com');
  const isLocalhost = hostname.includes('localhost') || hostname.includes('127.0.0.1');

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
  // 域名路由逻辑
  // ========================================

  // www 域名: 展示着陆页 (公开访问)
  if (isWwwDomain) {
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

  // 本地开发: 根据查询参数或路径判断
  if (isLocalhost) {
    // 本地开发时使用查询参数 ?domain=www 模拟 www 域名
    const domainParam = request.nextUrl.searchParams.get('domain');

    if (domainParam === 'www') {
      // 模拟 www 域名，公开访问
      return supabaseResponse;
    }

    // 默认行为: 模拟 app 域名逻辑
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
