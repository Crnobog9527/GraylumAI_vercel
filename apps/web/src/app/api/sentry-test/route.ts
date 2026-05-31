import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { logServerError } from '@/lib/server-log';
import { resolveSupabaseCookieOptions } from '@/lib/site-config';

const STAGING_PRODUCTION_HOST = 'graylumai-staging.vercel.app';

function getSentryDiagnostics() {
  const sentryClient = Sentry.getClient();
  const sentryOptions = sentryClient?.getOptions();

  return {
    dsnConfigured: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN || sentryOptions?.dsn),
    sentryClientConfigured: Boolean(sentryClient),
    vercelEnv: process.env.VERCEL_ENV ?? null,
    appEnv: process.env.APP_ENV ?? process.env.NEXT_PUBLIC_APP_ENV ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    sentryEnvironment:
      sentryOptions?.environment ??
      process.env.SENTRY_ENVIRONMENT ??
      process.env.NODE_ENV ??
      null,
  };
}

/**
 * Sentry 测试端点
 * GET /api/sentry-test - 触发测试错误，验证 Sentry 配置是否正常
 *
 * 注意: 此端点仅允许 graylumai-staging 的 Vercel Production deployment 使用。
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

function normalizeHost(value?: string): string {
  return (value ?? '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
}

function isStagingSentryVerificationAllowed(request: NextRequest): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const projectProductionHost = normalizeHost(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  const appEnv = process.env.APP_ENV ?? process.env.NEXT_PUBLIC_APP_ENV;

  if (appEnv && appEnv !== 'staging') {
    return false;
  }

  return (
    process.env.VERCEL_ENV === 'production' &&
    projectProductionHost === STAGING_PRODUCTION_HOST &&
    hostname === STAGING_PRODUCTION_HOST
  );
}

export async function GET(request: NextRequest) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const searchParams = new URL(request.url).searchParams;

  if (!isStagingSentryVerificationAllowed(request)) {
    return NextResponse.json(
      { error: "Not Found" },
      { status: 404 }
    );
  }

  const isAdminRequest = await isPreviewAdminRequest(request);
  if (!isAdminRequest) {
    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403 }
    );
  }

  const diagnostics = getSentryDiagnostics();

  // Add test context for better error tracking
  Sentry.setContext("sentry_test", {
    purpose: "验证 Sentry 配置",
    timestamp: new Date().toISOString(),
    environment: "staging",
    host: hostname,
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

  if (searchParams.get("mode") === "throw") {
    Sentry.setTag("environment", "staging");
    Sentry.setTag("endpoint", "/api/sentry-test");
    Sentry.setTag("verification", "true");
    Sentry.setTag("test_type", "unhandled_verification");

    throw new Error("graylumai-staging sentry unhandled verification");
  }

  // Create and capture a test error
  const testError = new Error(
    `graylumai-staging sentry verification - ${new Date().toISOString()}`
  );

  // Capture the error with additional context
  const eventId = Sentry.captureException(testError, {
    tags: {
      environment: "staging",
      endpoint: "/api/sentry-test",
      verification: "true",
      test_type: "manual_verification",
    },
    extra: {
      test_description: "验证 Sentry 错误监控配置是否正常工作",
    },
  });

  // Flush events to ensure they are sent before response
  const flushOk = await Sentry.flush(5000);

  // Return error response to indicate the test was triggered
  return NextResponse.json(
    {
      ok: true,
      message: "Sentry 测试错误已触发",
      description: "请检查 Sentry 后台是否收到错误报告",
      eventId,
      timestamp: new Date().toISOString(),
      environment: "staging",
      diagnostics: {
        ...diagnostics,
        flushOk,
      },
      instructions: [
        "1. 访问 Sentry 后台 (https://sentry.io)",
        "2. 在 Issues 页面查找 'graylumai-staging sentry verification' 错误",
        "3. 确认错误包含正确的上下文信息",
        "4. 验证用户信息 (sentry-test@graylum.internal) 已记录",
      ],
    },
    { status: 202 }
  );
}

// Also support POST for alternative testing
export async function POST(request: NextRequest) {
  return GET(request);
}
