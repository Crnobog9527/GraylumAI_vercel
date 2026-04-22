import { NextResponse } from 'next/server';
import { logServerError } from '@/lib/server-log';

const CRON_SECRET = process.env.CRON_SECRET;

export function validateCronRequest(request: Request, jobName: string): NextResponse | null {
  const authHeader = request.headers.get('authorization');

  if (CRON_SECRET) {
    if (authHeader === `Bearer ${CRON_SECRET}`) {
      return null;
    }

    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (process.env.NODE_ENV === 'production') {
    logServerError('security', 'cron_secret_missing_in_production', {
      jobName,
    });
    return NextResponse.json(
      { error: 'Cron endpoint is not configured' },
      { status: 503 }
    );
  }

  return null;
}
