/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { withViewVersionBump } from '@repo/api/src/services/runtimeViewVersion';
import { releaseDueAnnualSubscriptionCredits } from '@repo/api/src/services/subscriptionCreditGrants';
import { releaseMethodMembershipCredits } from '@repo/api/src/services/payments/methodMaintenance';
import { logger } from '@repo/api/src/services';
import { runPaymentReminders } from '@repo/api/src/services/notify/reminders';
import { reportAnnualReleaseAnomalies, reportPaymentNoticeAttention } from '@/lib/payment-alert.mjs';
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

    const supabase = createClient(supabaseUrl, supabaseServiceKey, { global: { fetch: withViewVersionBump(fetch) } });
    logger.system.cronJob('release-subscription-credits', 'started');
    const [creditWork, reminderWork] = await Promise.allSettled([
      (async () => {
        const result = await releaseDueAnnualSubscriptionCredits(supabase);
        const methodResult = await releaseMethodMembershipCredits(supabase);
        return { result, methodResult };
      })(),
      runPaymentReminders(supabase, { deadline: startedAt + 50_000 }),
    ]);
    const reminders = reminderWork.status === 'fulfilled' ? reminderWork.value
      : { success: false, attention: [{ attention: 'PAYMENT_NOTICE_SEND_FAILED' as const }] };
    reportPaymentNoticeAttention(reminders.attention);
    if (creditWork.status === 'rejected') throw creditWork.reason;
    const { result, methodResult } = creditWork.value;
    reportAnnualReleaseAnomalies(result.anomalies);
    const summary = {
      methodResult,
      reminders,
      scannedSubscriptions: result.scannedSubscriptions,
      releasedGrantCount: result.releasedGrantCount,
      skippedSubscriptions: result.skippedSubscriptions,
      releasedCredits: result.releasedCredits,
      anomalyCount: result.anomalies.length,
      anomalyReasons: [...new Set(result.anomalies.map(({ reason }) => reason))],
    };

    logger.system.cronJob(
      'release-subscription-credits',
      reminders.success ? 'completed' : 'failed',
      Date.now() - startedAt,
      undefined,
      { summary },
    );

    return NextResponse.json({
      success: reminders.success,
      summary,
      timestamp: new Date().toISOString(),
    }, { status: reminders.success ? 200 : 500 });
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
