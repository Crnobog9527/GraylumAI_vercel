import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  ConversationCleanupService,
  finishScheduledJobRun,
  SCHEDULED_JOB_KEYS,
  startScheduledJobRun,
} from '@repo/api/src/services';
import { validateCronRequest } from '@/lib/cron-auth';
import { logServerError, logServerInfo } from '@/lib/server-log';

export const runtime = 'nodejs';
export const maxDuration = 300;

const CRON_FAILURE_MESSAGE = 'Conversation cleanup failed';
const CRON_CONFIG_ERROR_MESSAGE = 'Server configuration error';
const SCHEDULED_RUN_ERROR_MESSAGE = '自动清理失败，请稍后重试';

async function handleRequest(request: Request) {
  const unauthorizedResponse = validateCronRequest(request, 'conversation_cleanup');
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: CRON_CONFIG_ERROR_MESSAGE }, { status: 500 });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const runId = await startScheduledJobRun({
      supabase,
      jobKey: SCHEDULED_JOB_KEYS.conversationCleanup,
      triggerSource: 'cron',
    });

    try {
      logServerInfo('system', 'cron_conversation_cleanup_started');

      const service = new ConversationCleanupService({ supabase });
      const result = await service.run();

      await finishScheduledJobRun({
        supabase,
        runId,
        status: 'success',
        summary: {
          deletedCount: result.deletedCount,
          stats: result.stats,
        },
      });

      logServerInfo('system', 'cron_conversation_cleanup_completed', {
        deletedCount: result.deletedCount,
      });

      return NextResponse.json({
        success: true,
        deletedCount: result.deletedCount,
        stats: result.stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      await finishScheduledJobRun({
        supabase,
        runId,
        status: 'error',
        error: SCHEDULED_RUN_ERROR_MESSAGE,
      });

      throw error;
    }
  } catch {
    logServerError('system', 'cron_conversation_cleanup_failed');

    return NextResponse.json(
      {
        success: false,
        error: CRON_FAILURE_MESSAGE,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handleRequest(request);
}

export async function POST(request: Request) {
  return handleRequest(request);
}
