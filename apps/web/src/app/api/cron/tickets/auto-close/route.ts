/**
 * Vercel Cron Job - Ticket Auto Close
 *
 * 工单在后台首次回复后，如果 48 小时内没有用户回复，则自动关闭并写入系统消息。
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  finishScheduledJobRun,
  SCHEDULED_JOB_KEYS,
  startScheduledJobRun,
  TicketAutoCloseService,
} from '@repo/api/src/services';
import { validateCronRequest } from '@/lib/cron-auth';
import { logServerError, logServerInfo } from '@/lib/server-log';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_FAILURE_MESSAGE = 'Ticket auto-close failed';
const CRON_CONFIG_ERROR_MESSAGE = 'Server configuration error';
const SCHEDULED_RUN_ERROR_MESSAGE = '工单自动关闭失败，请稍后重试';

async function handleRequest(request: Request) {
  const unauthorizedResponse = validateCronRequest(request, 'ticket_auto_close');
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: CRON_CONFIG_ERROR_MESSAGE },
      { status: 500 }
    );
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const runId = await startScheduledJobRun({
      supabase,
      jobKey: SCHEDULED_JOB_KEYS.ticketAutoClose,
      triggerSource: 'cron',
    });

    try {
      logServerInfo('system', 'cron_ticket_auto_close_started');

      const service = new TicketAutoCloseService({ supabase });
      const result = await service.run();

      await finishScheduledJobRun({
        supabase,
        runId,
        status: 'success',
        summary: {
          checked: result.checked,
          eligible: result.eligible,
          closed: result.closed,
        },
      });

      logServerInfo('system', 'cron_ticket_auto_close_completed', {
        checked: result.checked,
        eligible: result.eligible,
        closed: result.closed,
      });

      return NextResponse.json({
        success: true,
        checked: result.checked,
        eligible: result.eligible,
        closed: result.closed,
        decisions: result.decisions,
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
    logServerError('system', 'cron_ticket_auto_close_failed');

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

export async function GET(request: Request) {
  return handleRequest(request);
}

export async function POST(request: Request) {
  return handleRequest(request);
}
