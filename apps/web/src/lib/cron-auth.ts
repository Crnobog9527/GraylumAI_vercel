import { NextResponse } from 'next/server';

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
    console.error(`[Cron][${jobName}] CRON_SECRET is not configured in production`);
    return NextResponse.json(
      { error: 'Cron endpoint is not configured' },
      { status: 503 }
    );
  }

  return null;
}
