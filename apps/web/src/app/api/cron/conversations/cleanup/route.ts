import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  ConversationCleanupService,
  finishScheduledJobRun,
  SCHEDULED_JOB_KEYS,
  startScheduledJobRun,
} from '@repo/api/src/services';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

async function handleRequest(request: Request) {
  const unauthorizedResponse = validateCronRequest(request, 'conversation_cleanup');
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const runId = await startScheduledJobRun({
      supabase,
      jobKey: SCHEDULED_JOB_KEYS.conversationCleanup,
      triggerSource: 'cron',
    });

    try {
      console.info('[Cron][conversation_cleanup] started');

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

      console.info('[Cron][conversation_cleanup] completed', {
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
        error: error instanceof Error ? error.message : 'Unknown cleanup error',
      });

      throw error;
    }
  } catch (error) {
    console.error('Cron conversation cleanup failed:', error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
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
