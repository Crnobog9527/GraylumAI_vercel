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

export const runtime = 'nodejs';
export const maxDuration = 60; // 最长执行 60 秒

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
        { error: 'Missing Supabase configuration' },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 运行诊断测试
    const diagnosticsService = new DiagnosticsService({
      supabase,
      runType: 'cron',
    });

    const result = await diagnosticsService.runAllTests();

    // 返回结果摘要
    return NextResponse.json({
      success: true,
      batchId: result.batchId,
      runAt: result.runAt.toISOString(),
      summary: result.summary,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cron diagnostics failed:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
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
