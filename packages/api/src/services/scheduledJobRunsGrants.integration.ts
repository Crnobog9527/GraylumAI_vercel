/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// S1-FIX batch 2 (A-09): real job bookkeeping -> supabase-js -> local PostgREST with 0145 applied.
import { it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  finishScheduledJobRun,
  getLatestScheduledJobRun,
  SCHEDULED_JOB_KEYS,
  startScheduledJobRun,
} from './scheduledJobRuns';

const origin = process.env.S1F2_LOCAL_REST!;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')) throw new Error('S1-FIX-2 isolated runner required');
const nativeFetch = globalThis.fetch;
const localFetch: typeof fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin !== origin) throw new Error('Non-local request forbidden');
  target.pathname = target.pathname.replace(/^\/rest\/v1/, '');
  return nativeFetch(target, init);
};
const client = (key: string) => createClient(origin, key, {
  auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: localFetch },
});

it('S1-FIX-2: the cron bookkeeping starts, finishes and reads a run through service_role', async () => {
  const service = client(process.env.S1F2_SERVICE_JWT!);
  const runId = await startScheduledJobRun({
    supabase: service, jobKey: SCHEDULED_JOB_KEYS.ticketAutoClose, triggerSource: 'cron',
  });
  await finishScheduledJobRun({
    supabase: service, runId, status: 'success', summary: { checked: 1, eligible: 0, closed: 0 },
  });
  const latest = await getLatestScheduledJobRun(service, SCHEDULED_JOB_KEYS.ticketAutoClose);
  expect(latest).toMatchObject({ id: runId, status: 'success', trigger_source: 'cron',
    summary: { checked: 1, eligible: 0, closed: 0 }, error: null });
  expect(latest?.finished_at).toBeTruthy();
});

it('S1-FIX-2: users, admins and anonymous callers cannot start or finish job runs', async () => {
  for (const token of [process.env.S1F2_ADMIN_JWT!, process.env.S1F2_OWNER_JWT!, process.env.S1F2_ANON_JWT!]) {
    const caller = client(token);
    await expect(startScheduledJobRun({
      supabase: caller, jobKey: SCHEDULED_JOB_KEYS.ticketAutoClose, triggerSource: 'manual',
    })).rejects.toThrow('Failed to start scheduled job run');
    await expect(getLatestScheduledJobRun(caller, SCHEDULED_JOB_KEYS.ticketAutoClose))
      .rejects.toThrow('Failed to load scheduled job run');
  }
});
