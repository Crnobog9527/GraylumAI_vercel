import type { SupabaseClient } from '@supabase/supabase-js';

type MinimalSupabaseClient = Pick<SupabaseClient, 'from'>;

export const SCHEDULED_JOB_KEYS = {
  conversationCleanup: 'conversation_cleanup',
  ticketAutoClose: 'ticket_auto_close',
} as const;

const SCHEDULED_JOB_ERROR_MESSAGES = {
  start: 'Failed to start scheduled job run',
  finish: 'Failed to finish scheduled job run',
  load: 'Failed to load scheduled job run',
} as const;

export async function startScheduledJobRun(params: {
  supabase: MinimalSupabaseClient;
  jobKey: string;
  triggerSource: 'manual' | 'cron';
}) {
  const { data, error } = await params.supabase
    .from('scheduled_job_runs')
    .insert({
      job_key: params.jobKey,
      trigger_source: params.triggerSource,
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(SCHEDULED_JOB_ERROR_MESSAGES.start);
  }

  return data.id as string;
}

export async function finishScheduledJobRun(params: {
  supabase: MinimalSupabaseClient;
  runId: string;
  status: 'success' | 'error';
  summary?: Record<string, unknown>;
  error?: string | null;
}) {
  const { error } = await params.supabase
    .from('scheduled_job_runs')
    .update({
      status: params.status,
      finished_at: new Date().toISOString(),
      summary: params.summary ?? {},
      error: params.error ?? null,
    })
    .eq('id', params.runId);

  if (error) {
    throw new Error(SCHEDULED_JOB_ERROR_MESSAGES.finish);
  }
}

export async function getLatestScheduledJobRun(
  supabase: MinimalSupabaseClient,
  jobKey: string,
) {
  const { data, error } = await supabase
    .from('scheduled_job_runs')
    .select('id, status, trigger_source, started_at, finished_at, summary, error')
    .eq('job_key', jobKey)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(SCHEDULED_JOB_ERROR_MESSAGES.load);
  }

  return data;
}
