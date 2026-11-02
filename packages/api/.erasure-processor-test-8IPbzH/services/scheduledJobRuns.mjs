export const SCHEDULED_JOB_KEYS = {
    ticketAutoClose: 'ticket_auto_close',
};
const SCHEDULED_JOB_ERROR_MESSAGES = {
    start: 'Failed to start scheduled job run',
    finish: 'Failed to finish scheduled job run',
    load: 'Failed to load scheduled job run',
};
export async function startScheduledJobRun(params) {
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
    return data.id;
}
export async function finishScheduledJobRun(params) {
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
export async function getLatestScheduledJobRun(supabase, jobKey) {
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
