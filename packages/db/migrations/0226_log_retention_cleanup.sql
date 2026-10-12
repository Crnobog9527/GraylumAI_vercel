-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE E7 (logs at most 30 days; Owner 2026-10-12 approved adding the cleanup before launch).
-- 0148 dropped cleanup_old_logs and nothing replaced it. The daily account-erasure cron calls this,
-- so the cutoff is 29 days: a row written just after one run is gone by the run 29 days later,
-- before it is 30 days old. Bounded batches; repeated daily until nothing is left.
-- Not covered here on purpose: user_activity_logs (admin audit incl. credit adjustments and PAYG
-- metering review evidence referenced by bill2_calls) and ai_usage_logs (accounting, 3 years).
BEGIN;

CREATE OR REPLACE FUNCTION public.log_retention_cleanup(p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cutoff timestamptz:=clock_timestamp()-interval '29 days'; n_app bigint; n_diag bigint; n_jobs bigint;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>20000 THEN RAISE EXCEPTION 'LOG_RETENTION_LIMIT_INVALID'; END IF;
 DELETE FROM application_logs WHERE id IN
  (SELECT id FROM application_logs WHERE created_at<cutoff ORDER BY created_at LIMIT p_limit);
 GET DIAGNOSTICS n_app=ROW_COUNT;
 DELETE FROM diagnostic_results WHERE id IN
  (SELECT id FROM diagnostic_results WHERE created_at<cutoff ORDER BY created_at LIMIT p_limit);
 GET DIAGNOSTICS n_diag=ROW_COUNT;
 -- Per job, the newest run and the newest finished run are kept whatever their age: library cleanup
 -- resumes from the summary cursor of the latest finished run, even after an abandoned 'running' row.
 DELETE FROM scheduled_job_runs WHERE id IN
  (SELECT r.id FROM scheduled_job_runs r WHERE r.started_at<cutoff
    AND r.id<>(SELECT l.id FROM scheduled_job_runs l WHERE l.job_key=r.job_key ORDER BY l.started_at DESC,l.id DESC LIMIT 1)
    AND r.id IS DISTINCT FROM (SELECT f.id FROM scheduled_job_runs f WHERE f.job_key=r.job_key AND f.finished_at IS NOT NULL
      ORDER BY f.started_at DESC,f.id DESC LIMIT 1)
   ORDER BY r.started_at LIMIT p_limit);
 GET DIAGNOSTICS n_jobs=ROW_COUNT;
 RETURN jsonb_build_object('applicationLogs',n_app,'diagnosticResults',n_diag,'scheduledJobRuns',n_jobs,
  'more',n_app=p_limit OR n_diag=p_limit OR n_jobs=p_limit);
END $$;

REVOKE ALL ON FUNCTION public.log_retention_cleanup(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.log_retention_cleanup(integer) TO service_role;
COMMIT;
