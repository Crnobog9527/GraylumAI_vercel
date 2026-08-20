/**
 * Vercel Cron Job - System Diagnostics
 *
 * 定时运行系统诊断测试
 *
 * 配置方式:
 * 在 vercel.json 中添加:
 * {
 *   "crons": [{
 *     "path": "/api/cron/diagnostics",
 *     "schedule": "0 * * * *"  // 每小时运行一次
 *   }]
 * }
 *
 * @see https://vercel.com/docs/cron-jobs
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { DiagnosticsService } from '@repo/api/src/services/diagnostics';
import { validateCronRequest } from '@/lib/cron-auth';
import { logServerError, logServerInfo } from '@/lib/server-log';

export const runtime = 'nodejs';
export const maxDuration = 60; // 最长执行 60 秒

const CRON_FAILURE_MESSAGE = 'Diagnostics cron failed';
const CRON_CONFIG_ERROR_MESSAGE = 'Server configuration error';

export async function GET(request: Request) {
  const unauthorizedResponse = validateCronRequest(request, 'diagnostics');
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    // 创建 Supabase 客户端 (使用 service role key)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json(
        { error: CRON_CONFIG_ERROR_MESSAGE },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 运行诊断测试
    const diagnosticsService = new DiagnosticsService({
      supabase,
      supabaseAdmin: supabase,
      runType: 'cron',
    });

    logServerInfo('system', 'cron_diagnostics_started');
    const result = await diagnosticsService.runAllTests();
    logServerInfo('system', 'cron_diagnostics_completed', {
      batchId: result.batchId,
      passRate: result.summary.passRate,
    });

    // 返回结果摘要
    return NextResponse.json({
      success: true,
      batchId: result.batchId,
      runAt: result.runAt.toISOString(),
      summary: result.summary,
      timestamp: new Date().toISOString(),
    });
  } catch {
    logServerError('system', 'cron_diagnostics_failed');

    return NextResponse.json(
      {
        success: false,
        error: CRON_FAILURE_MESSAGE,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

// 也支持 POST 请求 (用于手动触发)
export async function POST(request: Request) {
  return GET(request);
}
