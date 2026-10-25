import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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

/** The service-role client a cron job works with, or null when the server is not configured. Lives here so a new cron route
 * does not add another file that reads process.env (scripts/pattern-ratchet.json). */
export function createCronServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
