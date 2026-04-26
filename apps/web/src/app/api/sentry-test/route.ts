import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { logServerError } from '@/lib/server-log';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

/**
 * Sentry 测试端点
 * GET /api/sentry-test - 触发测试错误，验证 Sentry 配置是否正常
 *
 * 注意: 此端点在生产环境中被禁用，仅供开发/预览环境测试使用
 *
 * 使用方式:
 * 1. 访问 /api/sentry-test 触发错误
 * 2. 30 秒内检查 Sentry 后台是否收到错误报告
 * 3. 错误报告应包含用户信息和请求详情
 */
async function isPreviewAdminRequest(request: NextRequest): Promise<boolean> {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const authClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: resolveSupabaseCookieOptions(hostname),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // Read-only auth check.
        },
      },
    }
  );

  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return false;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    logServerError('system', 'sentry_test_service_role_key_missing');
    return false;
  }

  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const { data: profile } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  return profile?.role === 'admin';
}

export async function GET(request: NextRequest) {
  // 生产环境禁用此测试端点
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Not Found" },
      { status: 404 }
    );
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  const isLocalRequest = hostname === 'localhost' || hostname === '127.0.0.1';

  if (!isLocalRequest) {
    const isAdminRequest = await isPreviewAdminRequest(request);
    if (!isAdminRequest) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      );
    }
  }

  // Add test context for better error tracking
  Sentry.setContext("sentry_test", {
    purpose: "验证 Sentry 配置",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });

  // Set a test user for tracking
  Sentry.setUser({
    id: "sentry-test-user",
    email: "sentry-test@graylum.internal",
    username: "Sentry Test",
  });

  // Add breadcrumb for tracing
  Sentry.addBreadcrumb({
    category: "test",
    message: "Sentry test endpoint called",
    level: "info",
  });

  // Create and capture a test error
  const testError = new Error(
    `[Sentry Test] 这是一个测试错误 - ${new Date().toISOString()}`
  );

  // Capture the error with additional context
  Sentry.captureException(testError, {
    tags: {
      test_type: "manual_verification",
      endpoint: "/api/sentry-test",
    },
    extra: {
      request_url: request.url,
      test_description: "验证 Sentry 错误监控配置是否正常工作",
    },
  });

  // Flush events to ensure they are sent before response
  await Sentry.flush(2000);

  // Return error response to indicate the test was triggered
  return NextResponse.json(
    {
      success: false,
      message: "Sentry 测试错误已触发",
      description: "请检查 Sentry 后台是否收到错误报告",
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      dsn_configured: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
      instructions: [
        "1. 访问 Sentry 后台 (https://sentry.io)",
        "2. 在 Issues 页面查找 '[Sentry Test]' 错误",
        "3. 确认错误包含正确的上下文信息",
        "4. 验证用户信息 (sentry-test@graylum.internal) 已记录",
      ],
    },
    { status: 500 }
  );
}

// Also support POST for alternative testing
export async function POST(request: NextRequest) {
  return GET(request);
}
