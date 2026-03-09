/**
 * Vercel Cron Job - Ticket Auto Close
 *
 * 工单在后台首次回复后，如果 48 小时内没有用户回复，则自动关闭并写入系统消息。
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { TicketAutoCloseService } from '@repo/api/src/services/ticketAutoClose';

const CRON_SECRET = process.env.CRON_SECRET;

export const runtime = 'nodejs';
export const maxDuration = 60;

function isAuthorizedCronRequest(request: Request) {
  const authHeader = request.headers.get('authorization');

  if (CRON_SECRET) {
    return authHeader === `Bearer ${CRON_SECRET}`;
  }

  const userAgent = request.headers.get('user-agent') ?? '';
  if (userAgent.includes('vercel-cron')) {
    return true;
  }

  return process.env.NODE_ENV !== 'production';
}

async function handleRequest(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: 'Missing Supabase configuration' },
      { status: 500 }
    );
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const service = new TicketAutoCloseService({ supabase });
    const result = await service.run();

    return NextResponse.json({
      success: true,
      checked: result.checked,
      eligible: result.eligible,
      closed: result.closed,
      decisions: result.decisions,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cron ticket auto-close failed:', error);

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

export async function GET(request: Request) {
  return handleRequest(request);
}

export async function POST(request: Request) {
  return handleRequest(request);
}
