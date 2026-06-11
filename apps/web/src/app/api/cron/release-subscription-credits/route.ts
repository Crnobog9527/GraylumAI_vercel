/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { releaseDueAnnualSubscriptionCredits } from '@repo/api/src/services/subscriptionCreditGrants';
import { logger } from '@repo/api/src/services';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_FAILURE_MESSAGE = 'Subscription credit release failed';
const CRON_CONFIG_ERROR_MESSAGE = 'Server configuration error';

export async function GET(request: Request) {
  const unauthorizedResponse = validateCronRequest(request, 'release-subscription-credits');
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const startedAt = Date.now();

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: CRON_CONFIG_ERROR_MESSAGE }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    logger.system.cronJob('release-subscription-credits', 'started');
    const summary = await releaseDueAnnualSubscriptionCredits(supabase);

    logger.system.cronJob(
      'release-subscription-credits',
      'completed',
      Date.now() - startedAt,
      undefined,
      { summary },
    );

    return NextResponse.json({
      success: true,
      summary,
      timestamp: new Date().toISOString(),
    });
  } catch {
    logger.system.cronJob(
      'release-subscription-credits',
      'failed',
      Date.now() - startedAt,
      '订阅积分释放失败，请查看服务端日志',
    );

    return NextResponse.json({
      success: false,
      error: CRON_FAILURE_MESSAGE,
      timestamp: new Date().toISOString(),
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
