import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runDailyBillingReconciliation } from '@repo/api/src/services/billingReconciliation';
import { logger } from '@repo/api/src/services';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_FAILURE_MESSAGE = 'Billing reconciliation failed';
const CRON_CONFIG_ERROR_MESSAGE = 'Server configuration error';

export async function GET(request: Request) {
  const unauthorizedResponse = validateCronRequest(request, 'billing-reconcile');
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
    logger.system.cronJob('billing-reconcile', 'started');
    const result = await runDailyBillingReconciliation(supabase);

    if (!result.success) {
      logger.system.cronJob(
        'billing-reconcile',
        'failed',
        Date.now() - startedAt,
        result.mismatches.join(' | '),
        { mismatches: result.mismatches, summary: result.summary },
      );
    } else {
      logger.system.cronJob(
        'billing-reconcile',
        'completed',
        Date.now() - startedAt,
        undefined,
        { summary: result.summary },
      );
    }

    return NextResponse.json({
      success: result.success,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      mismatches: result.mismatches,
      summary: result.summary,
      timestamp: new Date().toISOString(),
    }, { status: result.success ? 200 : 500 });
  } catch (error) {
    logger.system.cronJob(
      'billing-reconcile',
      'failed',
      Date.now() - startedAt,
      '账单对账失败，请查看服务端日志',
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
