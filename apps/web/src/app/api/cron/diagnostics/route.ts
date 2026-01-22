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
import { DiagnosticsService } from '@graylum/api/services';

// Vercel Cron 验证密钥
const CRON_SECRET = process.env.CRON_SECRET;

export const runtime = 'nodejs';
export const maxDuration = 60; // 最长执行 60 秒

export async function GET(request: Request) {
  // 验证 Cron 请求
  const authHeader = request.headers.get('authorization');

  // Vercel Cron 会发送 Bearer token
  if (CRON_SECRET) {
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
  } else {
    // 如果没有配置 CRON_SECRET，检查是否来自 Vercel Cron
    const userAgent = request.headers.get('user-agent') ?? '';
    if (!userAgent.includes('vercel-cron')) {
      // 生产环境拒绝未授权请求
      if (process.env.NODE_ENV === 'production') {
        return NextResponse.json(
          { error: 'Unauthorized - CRON_SECRET not configured' },
          { status: 401 }
        );
      }
    }
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
